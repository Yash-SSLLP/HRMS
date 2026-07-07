import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/client';
import { minutesToHHMM } from '../utils/time';

function initials(name = '') {
  const p = name.trim().split(/\s+/);
  return ((p[0]?.[0] || '') + (p[1]?.[0] || '')).toUpperCase() || '?';
}

const fmtTime = (d) =>
  d ? new Date(d).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true }) : '-';

// Decimal hours (e.g. 9.35) -> "09:21 Hrs"
const fmtHours = (h) => {
  if (!h || h <= 0) return '-';
  const hh = Math.floor(h);
  const mm = Math.round((h - hh) * 60);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')} Hrs`;
};

function Avatar({ name }) {
  return (
    <span className="w-10 h-10 rounded-full flex items-center justify-center text-sm font-semibold text-white shrink-0 accent-bg">
      {initials(name)}
    </span>
  );
}

function Row({ r, expanded, onToggle }) {
  return (
    <div className="border border-gray-100 rounded-xl mb-2 overflow-hidden">
      <button onClick={onToggle} className="w-full flex items-center gap-3 p-3 hover:bg-gray-50 text-left">
        <Avatar name={r.name} />
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-gray-900 flex items-center gap-2 truncate">
            {r.name}
            {r.lateMinutes > 0 && (
              <span className="inline-flex items-center gap-1 bg-red-500 text-white text-[11px] font-medium rounded-md px-1.5 py-0.5 shrink-0">
                ⏱ {minutesToHHMM(r.lateMinutes)}
              </span>
            )}
          </div>
          <div className="text-sm text-gray-500 truncate">{r.designation || r.department}</div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-gray-300">🕐</span>
          <span className="inline-flex items-center gap-1 bg-green-500 text-white text-xs font-semibold rounded-md px-2 py-1">
            <span className="w-1.5 h-1.5 rounded-full bg-white/80" /> {fmtTime(r.checkIn)}
          </span>
        </div>
      </button>

      {expanded && (
        <div className="grid grid-cols-3 gap-2 px-4 pb-3 pt-2 border-t border-gray-100 text-sm">
          <div>
            <div className="flex items-center gap-1.5 text-xs text-gray-500"><span className="w-1.5 h-1.5 rounded-full bg-green-500" /> Clock In</div>
            <div className="font-medium text-gray-800 mt-0.5">{fmtTime(r.checkIn)}</div>
          </div>
          <div>
            <div className="flex items-center gap-1.5 text-xs text-gray-500"><span className="w-1.5 h-1.5 rounded-full bg-red-500" /> Clock Out</div>
            <div className="font-medium text-gray-800 mt-0.5">{fmtTime(r.checkOut)}</div>
          </div>
          <div>
            <div className="flex items-center gap-1.5 text-xs text-gray-500"><span className="w-1.5 h-1.5 rounded-full bg-amber-500" /> Production</div>
            <div className="font-medium text-gray-800 mt-0.5">{fmtHours(r.hoursWorked)}</div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function ClockInOutCard() {
  const [board, setBoard] = useState({ onTime: [], late: [], departments: [] });
  const [dept, setDept] = useState('all');
  const [expandedId, setExpandedId] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = async (d) => {
    try {
      const { data } = await api.get('/attendance/today-board', { params: d && d !== 'all' ? { department: d } : {} });
      setBoard(data);
    } catch {
      // keep quiet on the dashboard
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(dept); /* eslint-disable-next-line */ }, [dept]);

  const toggle = (id) => setExpandedId((cur) => (cur === id ? null : id));
  const total = board.onTime.length + board.late.length;

  return (
    <div className="bg-white shadow rounded-lg p-5 flex flex-col">
      <div className="flex items-center justify-between gap-2 mb-4">
        <h2 className="card-title">Clock-In/Out</h2>
        <div className="flex items-center gap-2">
          <select
            value={dept}
            onChange={(e) => { setDept(e.target.value); setExpandedId(null); }}
            className="text-sm border border-gray-200 rounded-lg px-2 py-1.5 max-w-[10rem]"
          >
            <option value="all">All Departments</option>
            {board.departments.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
          <span className="text-sm border border-gray-200 rounded-lg px-2.5 py-1.5 text-gray-600 whitespace-nowrap">📅 Today</span>
        </div>
      </div>

      <div className="flex-1">
        {loading ? (
          <p className="text-sm text-gray-400">Loading…</p>
        ) : total === 0 ? (
          <p className="text-sm text-gray-400 italic py-6 text-center">No one has clocked in yet today.</p>
        ) : (
          <>
            {board.onTime.map((r) => (
              <Row key={r.recordId} r={r} expanded={expandedId === r.recordId} onToggle={() => toggle(r.recordId)} />
            ))}

            {board.late.length > 0 && (
              <>
                <div className="text-sm font-semibold text-gray-700 mt-3 mb-2">Late</div>
                {board.late.map((r) => (
                  <Row key={r.recordId} r={r} expanded={expandedId === r.recordId} onToggle={() => toggle(r.recordId)} />
                ))}
              </>
            )}
          </>
        )}
      </div>

      <Link
        to="/admin/attendance"
        className="block text-center text-sm font-medium text-gray-700 border border-gray-200 rounded-lg py-2.5 mt-3 hover:bg-gray-50"
      >
        View All Attendance
      </Link>
    </div>
  );
}
