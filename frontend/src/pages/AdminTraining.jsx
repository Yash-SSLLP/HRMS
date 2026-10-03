/**
 * AdminTraining — running instructor-led training (redesigned 2026-10-02).
 * Distinct from the LMS courses managed on AdminCourses.
 *
 * ONE PAGE, TWO MOUNTS: /admin/training and /employee/training. The second
 * exists because `training.manage` is grantable to ANY account by the
 * standalone User.trainingAccess switch — a training coordinator is often
 * neither HR nor a manager. Whoever holds the grant gets the whole module.
 * A CEO/MD in view-only mode and the God audit login see everything, change
 * nothing (`writable`).
 *
 * THE PAGE, top to bottom:
 *   KPIs        live now · upcoming · this month (sessions + time) · clarity
 *   Toolbar     Upcoming | Completed | Cancelled | All, month, category, search
 *   Sessions    cards grouped by month (live ones first), each with its date
 *               tile, time and length, trainer, people, attendance, rating,
 *               files and link — click for the full panel (TrainingDetail)
 *   Dialogs     book/edit (TrainingForm), categories, the monthly Excel report
 *
 * People are booked from GET /training/people — the module's own route, NOT
 * /admin/users, which is role-gated and would 403 for a grant holder.
 */
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'react-toastify';
import {
  FiPlus, FiDownload, FiTag, FiRadio, FiCalendar, FiClock, FiStar, FiSearch, FiX, FiUser,
  FiUsers, FiPaperclip, FiVideo, FiCopy, FiEdit2, FiChevronRight, FiBookOpen, FiAlertTriangle,
} from 'react-icons/fi';
import api from '../api/client';
import PageHeader from '../components/PageHeader';
import SearchableSelect from '../components/SearchableSelect';
import { useAuthStore } from '../store/authStore';
import { hasPermission, isViewOnly } from '../config/permissions';
import TrainingForm from '../components/training/TrainingForm';
import TrainingDetail from '../components/training/TrainingDetail';
import CategoryManager from '../components/training/CategoryManager';
import ExportDialog from '../components/training/ExportDialog';
import {
  DateTile, StatusPill, CategoryChip, AvatarStack, ScoreLine, EmptyState,
} from '../components/training/bits';
import {
  timeRange, durationText, relativeStart, monthKey, monthLabel, fullName, longDate,
} from '../components/training/trainingUtil';
import { formatTime12 } from '../utils/time';

const VIEWS = [
  { id: 'upcoming', label: 'Upcoming' },
  { id: 'completed', label: 'Completed' },
  { id: 'cancelled', label: 'Cancelled' },
  { id: 'all', label: 'All' },
];
const inView = (t, view) => {
  if (view === 'upcoming') return t.status === 'Planned' || t.status === 'Ongoing';
  if (view === 'completed') return t.status === 'Completed';
  if (view === 'cancelled') return t.status === 'Cancelled';
  return true;
};

function Kpi({ icon: Icon, hue, label, value, sub, onClick, on }) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag type={onClick ? 'button' : undefined} className={`trn-kpi ${on ? 'is-on' : ''}`} onClick={onClick}>
      <span className="trn-kpi-icon" style={{ '--kpi-hue': hue }}><Icon size={19} /></span>
      <span className="min-w-0">
        <span className="trn-kpi-label block text-gray-600">{label}</span>
        <span className="trn-kpi-value block text-gray-900">{value}</span>
        {sub && <span className="trn-kpi-sub block text-gray-600">{sub}</span>}
      </span>
    </Tag>
  );
}

function SessionCard({ t, writable, onOpen, onEdit }) {
  const live = t.status === 'Ongoing';
  const upcoming = t.status === 'Planned';
  const rel = upcoming ? relativeStart(t.startDate) : '';
  const soon = upcoming && t.startDate && new Date(t.startDate) - Date.now() < 3 * 3600 * 1000;
  const copy = async (e) => {
    e.stopPropagation();
    try { await navigator.clipboard.writeText(t.meetingLink); toast.success('Link copied'); } catch { toast.info(t.meetingLink); }
  };
  return (
    <div
      className={`trn-card ${live ? 'is-live' : ''} ${t.status === 'Cancelled' ? 'is-cancelled' : ''}`}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) onOpen(); }}
      aria-label={`${t.title}, ${longDate(t.startDate)}`}
    >
      <DateTile date={t.startDate} status={t.status} />
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-1.5">
          <StatusPill status={t.status} />
          <CategoryChip name={t.category} />
          {rel && <span className={`trn-rel ${soon ? 'is-soon' : ''} text-gray-700`}>{rel}</span>}
        </div>
        <div className="trn-title text-gray-900 mt-1.5 break-words">{t.title}</div>
        <div className="trn-meta text-gray-600">
          <span><FiClock size={13} />{timeRange(t)}</span>
          {t.durationMinutes ? <span className="font-medium text-gray-700">{durationText(t.durationMinutes)}</span> : null}
          <span>
            <FiUser size={13} />
            {t.trainer || <span className="text-gray-400">No trainer named</span>}
            {t.trainerType === 'external' && <span className="trn-tag is-amber">Outside</span>}
          </span>
        </div>
        <div className="trn-meta text-gray-600" style={{ marginTop: '0.55rem' }}>
          <span>
            {t.participants.length > 0 && <AvatarStack people={t.participants} />}
            <span><b className="text-gray-800">{t.participantCount}</b> participant{t.participantCount === 1 ? '' : 's'}</span>
          </span>
          {(t.status === 'Completed' || live) && t.participantCount > 0 && (
            <span><FiUsers size={13} />{t.attendedCount} joined</span>
          )}
          {t.status === 'Completed' && <span><ScoreLine summary={t.feedbackSummary} empty="No reviews yet" /></span>}
          {t.attachments.length > 0 && <span><FiPaperclip size={13} />{t.attachments.length} file{t.attachments.length === 1 ? '' : 's'}</span>}
          {t.meetingLink && t.status !== 'Cancelled' && <span><FiVideo size={13} />{t.meetAuto ? 'Google Meet' : 'Meeting link'}</span>}
        </div>
      </div>
      <div className="trn-card-actions" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()} role="presentation">
        {live && t.meetingLink && (
          <a className="trn-btn is-live" href={t.meetingLink} target="_blank" rel="noopener noreferrer"><FiVideo size={14} /> Join now</a>
        )}
        {upcoming && t.meetingLink && (
          <button type="button" className="trn-btn" onClick={copy}><FiCopy size={14} /> Copy link</button>
        )}
        {writable && t.status !== 'Cancelled' && (
          <button type="button" className="trn-btn" onClick={() => onEdit(t)}><FiEdit2 size={14} /> Edit</button>
        )}
        <button type="button" className="trn-btn" onClick={onOpen}>Details <FiChevronRight size={14} /></button>
      </div>
    </div>
  );
}

export default function AdminTraining() {
  const user = useAuthStore((st) => st.user);
  const writable = hasPermission(user, 'training.manage') && !isViewOnly(user);

  const [trainings, setTrainings] = useState([]);
  const [categories, setCategories] = useState([]);
  const [meetAvailable, setMeetAvailable] = useState(false);
  const [people, setPeople] = useState([]);
  const [includeExecutives, setIncludeExecutives] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [view, setView] = useState('upcoming');
  const [month, setMonth] = useState('');
  const [category, setCategory] = useState('');
  const [q, setQ] = useState('');

  const [detailId, setDetailId] = useState(null);
  const [formFor, setFormFor] = useState(null); // null = closed, {} = new, training = edit
  const [showCategories, setShowCategories] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [, setTick] = useState(0);

  const load = async () => {
    try {
      const [tRes, pRes] = await Promise.all([
        api.get('/training'),
        writable ? api.get('/training/people').catch(() => null) : Promise.resolve(null),
      ]);
      setTrainings(tRes.data.trainings || []);
      setCategories(tRes.data.categories || []);
      setMeetAvailable(!!tRes.data.meetAvailable);
      if (pRes) {
        setPeople(pRes.data.users || []);
        setIncludeExecutives(!!pRes.data.includeExecutives);
      }
      setError('');
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load trainings');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, [writable]); // eslint-disable-line react-hooks/exhaustive-deps

  // Live / upcoming flip with the clock: refresh the relative chips each
  // minute and re-read the list every five, so a session goes Live on screen.
  useEffect(() => {
    const a = setInterval(() => setTick((n) => n + 1), 60 * 1000);
    const b = setInterval(() => load(), 5 * 60 * 1000);
    return () => { clearInterval(a); clearInterval(b); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const kpis = useMemo(() => {
    const thisMonth = monthKey(new Date());
    const live = trainings.filter((t) => t.status === 'Ongoing');
    const upcoming = trainings.filter((t) => t.status === 'Planned')
      .sort((a, b) => new Date(a.startDate || 8.64e15) - new Date(b.startDate || 8.64e15));
    const month = trainings.filter((t) => t.status !== 'Cancelled' && t.startDate && monthKey(t.startDate) === thisMonth);
    const reviews = month.reduce((acc, t) => {
      const s = t.feedbackSummary;
      if (s?.count && s.clarity) { acc.n += s.count; acc.sum += s.clarity * s.count; }
      return acc;
    }, { n: 0, sum: 0 });
    return {
      live: live.length,
      liveTitle: live[0]?.title,
      upcoming: upcoming.length,
      next: upcoming[0],
      month: month.length,
      monthMinutes: month.reduce((s, t) => s + (t.durationMinutes || 0), 0),
      clarity: reviews.n ? Math.round((reviews.sum / reviews.n) * 10) / 10 : null,
      reviews: reviews.n,
    };
  }, [trainings]);

  const counts = useMemo(() => Object.fromEntries(VIEWS.map((v) => [v.id, trainings.filter((t) => inView(t, v.id)).length])), [trainings]);

  const months = useMemo(() => [...new Set(trainings.filter((t) => t.startDate).map((t) => monthKey(t.startDate)))].sort().reverse(), [trainings]);
  const categoryNames = useMemo(() => {
    const s = new Set(categories.map((c) => c.name));
    trainings.forEach((t) => { if (t.category) s.add(t.category); });
    return [...s].sort((a, b) => a.localeCompare(b));
  }, [categories, trainings]);

  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    const list = trainings.filter((t) => {
      if (!inView(t, view)) return false;
      if (category && (t.category || '') !== category) return false;
      if (month && view !== 'upcoming' && (!t.startDate || monthKey(t.startDate) !== month)) return false;
      if (!s) return true;
      const hay = `${t.title} ${t.trainer || ''} ${t.category || ''} ${t.description || ''} ${t.participants.map(fullName).join(' ')}`.toLowerCase();
      return hay.includes(s);
    });
    const asc = view === 'upcoming';
    return list.sort((a, b) => {
      if (a.status === 'Ongoing' && b.status !== 'Ongoing') return -1;
      if (b.status === 'Ongoing' && a.status !== 'Ongoing') return 1;
      const da = new Date(a.startDate || 0).getTime();
      const db = new Date(b.startDate || 0).getTime();
      return asc ? da - db : db - da;
    });
  }, [trainings, view, category, month, q]);

  const groups = useMemo(() => {
    const out = [];
    const byKey = new Map();
    shown.forEach((t) => {
      const key = t.status === 'Ongoing' ? 'live' : (t.startDate ? monthKey(t.startDate) : 'none');
      if (!byKey.has(key)) { byKey.set(key, []); out.push(key); }
      byKey.get(key).push(t);
    });
    return out.map((key) => {
      const items = byKey.get(key);
      const held = items.filter((t) => t.status !== 'Cancelled');
      return {
        key,
        title: key === 'live' ? 'Happening now' : key === 'none' ? 'No date set' : monthLabel(key),
        items,
        minutes: held.reduce((s, t) => s + (t.durationMinutes || 0), 0),
      };
    });
  }, [shown]);

  const filtersOn = !!(category || q || (month && view !== 'upcoming'));
  const clearFilters = () => { setCategory(''); setQ(''); setMonth(''); };

  const openEdit = (t) => { setDetailId(null); setFormFor(t); };
  const afterSave = async (id, isNew) => {
    setFormFor(null);
    // A new booking is upcoming — show the list it now sits in.
    if (isNew) { setView('upcoming'); setMonth(''); }
    await load();
    if (id) setDetailId(id);
  };

  return (
    <div>
      <PageHeader title="Training">
        <button type="button" className="trn-btn" onClick={() => setShowExport(true)}><FiDownload size={15} /> Export report</button>
        {writable && <button type="button" className="trn-btn" onClick={() => setShowCategories(true)}><FiTag size={15} /> Categories</button>}
        {writable && (
          <button type="button" className="trn-btn is-primary accent-bg on-accent" onClick={() => setFormFor({})}><FiPlus size={16} /> New training</button>
        )}
      </PageHeader>

      {error && (
        <div className="trn-note is-warn text-gray-700 mb-4"><FiAlertTriangle size={15} className="shrink-0 mt-0.5" /> {error}</div>
      )}

      <div className="trn-kpis mb-4">
        <Kpi icon={FiRadio} hue="#dc2626" label="Live now" value={kpis.live}
          sub={kpis.live ? kpis.liveTitle : 'Nothing on right now'} on={view === 'upcoming' && kpis.live > 0}
          onClick={() => { setView('upcoming'); setMonth(''); }} />
        <Kpi icon={FiCalendar} hue="var(--accent)" label="Upcoming" value={kpis.upcoming}
          sub={kpis.next ? `Next: ${longDate(kpis.next.startDate).replace(/ \d{4}$/, '')}${kpis.next.startDate ? `, ${formatTime12(kpis.next.startDate)}` : ''}` : 'Nothing booked'}
          onClick={() => { setView('upcoming'); setMonth(''); }} />
        <Kpi icon={FiBookOpen} hue="#0d9488" label="This month" value={kpis.month}
          sub={kpis.month ? `${durationText(kpis.monthMinutes) || '0m'} of training` : 'No sessions yet'}
          onClick={() => { setView('all'); setMonth(monthKey(new Date())); }} />
        <Kpi icon={FiStar} hue="#d97706" label="Avg clarity" value={kpis.clarity ? `${kpis.clarity}/5` : '—'}
          sub={kpis.reviews ? `${kpis.reviews} review${kpis.reviews === 1 ? '' : 's'} this month` : 'No reviews this month'}
          onClick={() => { setView('completed'); setMonth(monthKey(new Date())); }} />
      </div>

      <div className="trn-card-base trn-toolbar mb-2">
        <div className="trn-seg" role="tablist" aria-label="Which trainings">
          {VIEWS.map((v) => (
            <button key={v.id} type="button" role="tab" aria-selected={view === v.id} className={`trn-seg-btn ${view === v.id ? 'is-on' : ''} text-gray-800`} onClick={() => setView(v.id)}>
              {v.label} <span className="trn-seg-count">{counts[v.id]}</span>
            </button>
          ))}
        </div>
        {view !== 'upcoming' && months.length > 0 && (
          <SearchableSelect className="trn-select text-gray-800" value={month} onChange={(e) => setMonth(e.target.value)} aria-label="Month">
            <option value="">Every month</option>
            {months.map((k) => <option key={k} value={k}>{monthLabel(k)}</option>)}
          </SearchableSelect>
        )}
        {categoryNames.length > 0 && (
          <SearchableSelect className="trn-select text-gray-800" value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category">
            <option value="">Every category</option>
            {categoryNames.map((c) => <option key={c} value={c}>{c}</option>)}
          </SearchableSelect>
        )}
        <label className="trn-search">
          <FiSearch size={15} className="text-gray-400" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search title, trainer, participant…" aria-label="Search trainings" />
          {q && <button type="button" className="text-gray-400" onClick={() => setQ('')} aria-label="Clear search"><FiX size={14} /></button>}
        </label>
      </div>

      {loading ? (
        <div className="space-y-3 mt-4">
          {[0, 1, 2].map((i) => <div key={i} className="trn-card-base p-4 flex gap-4"><div className="skeleton w-14 h-16 rounded-xl" /><div className="flex-1 space-y-2.5"><div className="skeleton h-4 rounded w-1/3" /><div className="skeleton h-5 rounded w-2/3" /><div className="skeleton h-4 rounded w-1/2" /></div></div>)}
        </div>
      ) : shown.length === 0 ? (
        <div className="trn-card-base mt-4">
          {filtersOn ? (
            <EmptyState icon={FiSearch} title="Nothing matches those filters" action={<button type="button" className="trn-btn" onClick={clearFilters}>Clear filters</button>} />
          ) : view === 'upcoming' ? (
            <EmptyState icon={FiCalendar} title="No upcoming trainings"
              action={writable ? <button type="button" className="trn-btn is-primary accent-bg on-accent" onClick={() => setFormFor({})}><FiPlus size={15} /> Book a training</button> : null}>
            </EmptyState>
          ) : (
            <EmptyState icon={FiBookOpen} title={`No ${view === 'all' ? '' : `${view} `}trainings`}>
            </EmptyState>
          )}
        </div>
      ) : (
        groups.map((g) => (
          <section key={g.key}>
            <div className="trn-group-head">
              <span className="trn-group-title text-gray-700">{g.title}</span>
              <span className="trn-group-sub text-gray-600">
                {g.items.length} session{g.items.length === 1 ? '' : 's'}{g.minutes ? ` · ${durationText(g.minutes)}` : ''}
              </span>
            </div>
            {g.items.map((t) => (
              <SessionCard key={t._id} t={t} writable={writable} onOpen={() => setDetailId(t._id)} onEdit={openEdit} />
            ))}
          </section>
        ))
      )}

      {detailId && (
        <TrainingDetail
          id={detailId}
          writable={writable}
          meetAvailable={meetAvailable}
          onClose={() => setDetailId(null)}
          onEdit={openEdit}
          onChanged={load}
        />
      )}
      {formFor && (
        <TrainingForm
          training={formFor._id ? formFor : null}
          people={people}
          includeExecutives={includeExecutives}
          categories={categories}
          meetAvailable={meetAvailable}
          onClose={() => setFormFor(null)}
          onSaved={afterSave}
          onCategoriesChanged={setCategories}
        />
      )}
      {showCategories && (
        <CategoryManager onClose={() => setShowCategories(false)} onChanged={(c) => { setCategories(c); load(); }} />
      )}
      {showExport && <ExportDialog trainings={trainings} onClose={() => setShowExport(false)} />}
    </div>
  );
}
