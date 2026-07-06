import { useEffect, useState } from 'react';
import api from '../api/client';
import AuthImage from '../components/AuthImage';
import PageHeader from '../components/PageHeader';

const fmtTime = (d) =>
  d ? new Date(d).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true }) : '-';
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) : '-');

const LEAVE_LABEL = {
  EL: 'Earned', CL: 'Casual', SL: 'Sick', ML: 'Maternity', PL: 'Paternity', COMP: 'Comp-off', LOP: 'Loss of Pay',
};

// Initials avatar fallback when a person has no profile photo.
function Initials({ name, className = '' }) {
  const initials = (name || '?')
    .split(' ')
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
  return (
    <span className={`inline-flex items-center justify-center bg-indigo-100 text-indigo-700 font-semibold ${className}`}>
      {initials}
    </span>
  );
}

// A person's face: the check-in selfie if one exists (captured identically from
// web or mobile), else their profile photo, else initials.
function FaceThumb({ person, size = 'w-11 h-11', onOpen }) {
  const selfieUrl = person.hasCheckInPhoto ? `/attendance/${person.recordId}/photo/checkin` : null;
  const avatarUrl = person.hasAvatar && person.userId ? `/auth/users/${person.userId}/avatar` : null;
  const url = selfieUrl || avatarUrl;
  const fallback = <Initials name={person.name} className={`${size} rounded-full text-sm`} />;
  if (!url) return fallback;
  return (
    <AuthImage
      url={url}
      alt={person.name}
      className={`${size} rounded-full object-cover border border-gray-200 ${selfieUrl && onOpen ? 'cursor-pointer' : ''}`}
      fallback={fallback}
      onClick={selfieUrl && onOpen ? () => onOpen(person) : undefined}
    />
  );
}

function StatCard({ label, value, tone }) {
  const tones = {
    present: 'border-green-200 bg-green-50 text-green-700',
    leave: 'border-purple-200 bg-purple-50 text-purple-700',
    absent: 'border-red-200 bg-red-50 text-red-700',
    total: 'border-gray-200 bg-gray-50 text-gray-700',
  };
  return (
    <div className={`rounded-xl border px-4 py-3 ${tones[tone]}`}>
      <div className="text-2xl font-bold leading-none">{value}</div>
      <div className="text-xs font-medium mt-1 uppercase tracking-wide">{label}</div>
    </div>
  );
}

export default function AdminPresence() {
  const [board, setBoard] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [dept, setDept] = useState('all');
  const [tab, setTab] = useState('present');
  const [photoModal, setPhotoModal] = useState(null); // person with check-in selfie

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (dept && dept !== 'all') params.set('department', dept);
      const { data } = await api.get(`/attendance/presence-board?${params}`);
      setBoard(data);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load presence board');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [dept]);

  const counts = board?.counts || { total: 0, present: 0, onLeave: 0, absent: 0 };
  const departments = board?.departments || [];

  const tabs = [
    { key: 'present', label: `Present (${counts.present})` },
    { key: 'leave', label: `On Leave (${counts.onLeave})` },
    { key: 'absent', label: `Absent (${counts.absent})` },
  ];

  return (
    <div>
      <PageHeader
        title="Who's In & On Leave"
        subtitle={board ? `Today · ${fmtDate(board.date)} · ${counts.present} present of ${counts.total}` : 'Live attendance snapshot'}
      >
        <select
          value={dept}
          onChange={(e) => setDept(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white"
        >
          <option value="all">All departments</option>
          {departments.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
        <button
          onClick={load}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white hover:bg-gray-50"
        >
          Refresh
        </button>
      </PageHeader>

      {error && <div className="mb-4 rounded-lg bg-red-50 border border-red-200 text-red-700 px-4 py-2 text-sm">{error}</div>}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
        <StatCard label="Present" value={counts.present} tone="present" />
        <StatCard label="On Leave" value={counts.onLeave} tone="leave" />
        <StatCard label="Absent" value={counts.absent} tone="absent" />
        <StatCard label="Headcount" value={counts.total} tone="total" />
      </div>

      <div className="flex gap-1 border-b border-gray-200 mb-4">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2 text-sm font-medium -mb-px border-b-2 ${
              tab === t.key ? 'border-indigo-600 text-indigo-700' : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="text-gray-400 text-sm py-10 text-center">Loading…</div>
      ) : (
        <>
          {tab === 'present' && <PresentGrid people={board?.present || []} onOpen={setPhotoModal} />}
          {tab === 'leave' && <LeaveGrid people={board?.onLeave || []} />}
          {tab === 'absent' && <AbsentGrid people={board?.absent || []} />}
        </>
      )}

      {photoModal && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={() => setPhotoModal(null)}>
          <div className="bg-white rounded-xl p-3 max-w-sm w-full" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-2 px-1">
              <div>
                <div className="text-sm font-semibold">{photoModal.name}</div>
                <div className="text-xs text-gray-500">Check-in selfie · {fmtTime(photoModal.checkIn)}</div>
              </div>
              <button onClick={() => setPhotoModal(null)} className="text-gray-400 hover:text-gray-700 text-2xl leading-none">×</button>
            </div>
            <AuthImage url={`/attendance/${photoModal.recordId}/photo/checkin`} alt={photoModal.name} className="w-full rounded-lg" />
            {photoModal.hasCheckOutPhoto && (
              <div className="mt-3">
                <div className="text-xs text-gray-500 mb-1 px-1">Check-out selfie · {fmtTime(photoModal.checkOut)}</div>
                <AuthImage url={`/attendance/${photoModal.recordId}/photo/checkout`} alt={photoModal.name} className="w-full rounded-lg" />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function EmptyState({ text }) {
  return <div className="text-gray-400 text-sm py-10 text-center">{text}</div>;
}

function PresentGrid({ people, onOpen }) {
  if (!people.length) return <EmptyState text="Nobody has checked in yet." />;
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {people.map((p) => (
        <div key={p.profileId} className="bg-white rounded-xl border border-gray-200 p-3 flex items-center gap-3">
          <FaceThumb person={p} onOpen={onOpen} />
          <div className="min-w-0 flex-1">
            <div className="font-medium text-gray-900 truncate">{p.name}</div>
            <div className="text-xs text-gray-500 truncate">{p.designation || p.department}</div>
            <div className="text-xs text-gray-400 mt-0.5 flex items-center gap-1.5 flex-wrap">
              <span className="text-green-600 font-medium">In {fmtTime(p.checkIn)}</span>
              {p.checkOut && <span>· Out {fmtTime(p.checkOut)}</span>}
              {p.checkInWfh && <span className="px-1.5 rounded bg-indigo-100 text-indigo-700 text-[10px] font-medium">WFH</span>}
              {p.lateMinutes > 0 && <span className="px-1.5 rounded bg-amber-100 text-amber-800 text-[10px] font-medium">Late {p.lateMinutes}m</span>}
              {p.status === 'HalfDay' && <span className="px-1.5 rounded bg-amber-100 text-amber-800 text-[10px] font-medium">Half day</span>}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function LeaveGrid({ people }) {
  if (!people.length) return <EmptyState text="Nobody is on approved leave today." />;
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {people.map((p) => (
        <div key={p.profileId} className="bg-white rounded-xl border border-gray-200 p-3 flex items-center gap-3">
          <FaceThumb person={p} />
          <div className="min-w-0 flex-1">
            <div className="font-medium text-gray-900 truncate">{p.name}</div>
            <div className="text-xs text-gray-500 truncate">{p.designation || p.department}</div>
            <div className="text-xs text-gray-400 mt-0.5 flex items-center gap-1.5 flex-wrap">
              <span className="px-1.5 rounded bg-purple-100 text-purple-700 text-[10px] font-medium">
                {LEAVE_LABEL[p.leaveType] || p.leaveType}{p.isHalfDay ? ' · Half' : ''}
              </span>
              <span>{fmtDate(p.startDate)}{p.endDate && fmtDate(p.endDate) !== fmtDate(p.startDate) ? ` – ${fmtDate(p.endDate)}` : ''}</span>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function AbsentGrid({ people }) {
  if (!people.length) return <EmptyState text="Everyone is accounted for." />;
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {people.map((p) => (
        <div key={p.profileId} className="bg-white rounded-xl border border-gray-200 p-3 flex items-center gap-3">
          <FaceThumb person={p} />
          <div className="min-w-0 flex-1">
            <div className="font-medium text-gray-900 truncate">{p.name}</div>
            <div className="text-xs text-gray-500 truncate">{p.designation || p.department}</div>
            <div className="text-xs text-red-500 mt-0.5">No check-in · not on leave</div>
          </div>
        </div>
      ))}
    </div>
  );
}
