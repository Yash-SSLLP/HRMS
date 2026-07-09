import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { FiUsers } from 'react-icons/fi';
import api from '../api/client';

// Manager dashboard card: today's status of everyone who reports to the caller
// (present / late / on leave / absent). Data comes from the same endpoint the
// full "My Team" board uses. Renders nothing when the caller has no reports.
const fmtDate = (d) => new Date(d).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'short' });

const sub = (p) => [p.designation, p.department].filter(Boolean).join(' · ');

function Chip({ name, note, dot }) {
  return (
    <span className="inline-flex items-center gap-1.5 max-w-full bg-gray-50 border border-gray-200 rounded-full px-2.5 py-1 text-xs text-gray-700">
      {dot && <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: dot }} />}
      <span className="truncate">{name}</span>
      {note ? <span className="text-gray-400 shrink-0">· {note}</span> : null}
    </span>
  );
}

function Group({ title, color, people, render }) {
  if (!people.length) return null;
  return (
    <div>
      <div className="text-xs font-semibold text-gray-600 mb-1.5">
        {title} <span className="text-gray-400">({people.length})</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {people.map((p) => (
          <Chip key={p.profileId} name={p.name} dot={color} note={render ? render(p) : sub(p)} />
        ))}
      </div>
    </div>
  );
}

export default function ManagerTeamStatus() {
  const [board, setBoard] = useState(null);

  useEffect(() => {
    api.get('/manager/presence').then(({ data }) => setBoard(data)).catch(() => {});
  }, []);

  if (!board || (board.counts?.total || 0) === 0) return null;

  const present = board.present || [];
  const late = present.filter((p) => p.lateMinutes > 0);
  const onLeave = board.onLeave || [];
  const absent = board.absent || [];

  const tiles = [
    { label: 'Present', value: present.length, color: '#16a34a' },
    { label: 'Late', value: late.length, color: '#ec4899' },
    { label: 'On leave', value: onLeave.length, color: '#8b5cf6' },
    { label: 'Absent', value: absent.length, color: '#ef4444' },
  ];

  return (
    <div className="mb-4 bg-white shadow rounded-lg p-5">
      <div className="flex items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-2 min-w-0">
          <FiUsers className="text-gray-400 shrink-0" size={16} />
          <h2 className="card-title truncate">Your team today</h2>
          <span className="text-xs text-gray-400 hidden sm:inline">· {fmtDate(board.date)}</span>
        </div>
        <Link to="/employee/team" className="text-xs text-blue-600 hover:underline shrink-0">Team board →</Link>
      </div>

      {/* Summary tiles */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
        {tiles.map((t) => (
          <div key={t.label} className="rounded-lg border border-gray-100 p-3">
            <div className="text-2xl font-semibold" style={{ color: t.color }}>{t.value}</div>
            <div className="text-xs text-gray-500 mt-0.5">{t.label}</div>
          </div>
        ))}
      </div>

      {/* Who's where — exceptions first, then present */}
      <div className="space-y-3">
        <Group title="Late" color="#ec4899" people={late}
          render={(p) => (p.lateMinutes ? `${p.lateMinutes} min late` : sub(p))} />
        <Group title="On leave" color="#8b5cf6" people={onLeave}
          render={(p) => (p.leaveType ? `${p.leaveType}${p.isHalfDay ? ' · half day' : ''}` : sub(p))} />
        <Group title="Absent" color="#ef4444" people={absent} />
        <Group title="Present" color="#16a34a" people={present}
          render={(p) => (p.lateMinutes > 0 ? `${p.lateMinutes} min late` : (p.status === 'HalfDay' ? 'half day' : 'on time'))} />
      </div>
    </div>
  );
}
