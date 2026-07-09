import { useEffect, useMemo, useState } from 'react';
import { FiVideo, FiFileText, FiX } from 'react-icons/fi';
import api from '../api/client';
import PageHeader from '../components/PageHeader';

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const TYPE_STYLES = {
  holiday: 'bg-red-100 text-red-800',
  event: 'bg-emerald-100 text-emerald-800',
  birthday: 'bg-purple-100 text-purple-800',
  anniversary: 'bg-blue-100 text-blue-800',
  interview: 'bg-amber-100 text-amber-800',
};
const TYPE_LABELS = {
  holiday: 'Holiday',
  event: 'Event',
  birthday: 'Birthday',
  anniversary: 'Work anniversary',
  interview: 'Interview',
};

export default function Calendar() {
  const today = new Date();
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth() + 1); // 1-12
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null); // event opened in the detail modal
  const [resumeBusy, setResumeBusy] = useState(false);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const mm = String(month).padStart(2, '0');
      const { data } = await api.get(`/celebrations/calendar?month=${year}-${mm}`);
      setEvents(data.events);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load calendar');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [year, month]);

  const eventsByDay = useMemo(() => {
    const map = {};
    for (const e of events) {
      (map[e.day] = map[e.day] || []).push(e);
    }
    return map;
  }, [events]);

  const prev = () => {
    if (month === 1) { setMonth(12); setYear(year - 1); }
    else setMonth(month - 1);
  };
  const next = () => {
    if (month === 12) { setMonth(1); setYear(year + 1); }
    else setMonth(month + 1);
  };

  // Build the grid: leading blanks for the first weekday, then days of month.
  const firstWeekday = new Date(year, month - 1, 1).getDay();
  const daysInMonth = new Date(year, month, 0).getDate();
  const cells = [];
  for (let i = 0; i < firstWeekday; i += 1) cells.push(null);
  for (let d = 1; d <= daysInMonth; d += 1) cells.push(d);

  const isToday = (d) =>
    d === today.getDate() && month === today.getMonth() + 1 && year === today.getFullYear();

  // Detail rows shown in the event modal, per event type.
  const detailRows = (e) => {
    const m = e.meta || {};
    const rows = [];
    if (e.type === 'holiday') {
      if (m.holidayType) rows.push(['Type', m.holidayType]);
      if (m.description) rows.push(['Details', m.description]);
    } else if (e.type === 'event') {
      if (m.time) rows.push(['Time', m.time]);
      if (m.location) rows.push(['Location', m.location]);
      if (m.description) rows.push(['Details', m.description]);
    } else if (e.type === 'interview') {
      if (m.time) rows.push(['Time', m.time]);
      if (m.durationMinutes) rows.push(['Duration', m.durationMinutes < 60 ? `${m.durationMinutes} min` : `${m.durationMinutes / 60} hr`]);
      if (m.round) rows.push(['Round', m.round]);
      if (m.jobTitle) rows.push(['Role', m.jobTitle]);
      if (m.status) rows.push(['Status', m.status]);
    } else {
      const role = [m.designation, m.department].filter(Boolean).join(' · ');
      if (role) rows.push(['Role', role]);
      if (m.employeeCode) rows.push(['Code', m.employeeCode]);
      if (e.type === 'anniversary' && m.years) rows.push(['Years', `${m.years}`]);
    }
    return rows;
  };

  // Open the candidate's resume in a new tab. The endpoint is token-protected,
  // so fetch it as a blob (auth header attached) and open an object URL.
  const openResume = async (candidateId) => {
    if (!candidateId) return;
    setResumeBusy(true);
    try {
      const res = await api.get(`/recruitment/my-interviews/${candidateId}/resume`, { responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch {
      setError('Could not open the resume.');
    } finally {
      setResumeBusy(false);
    }
  };

  return (
    <div>
      <PageHeader title="Calendar">
        <button onClick={prev} className="px-3 py-1.5 border rounded-lg hover:bg-gray-50 text-sm">‹ Prev</button>
        <span className="text-sm font-medium text-gray-800 w-40 text-center">
          {MONTH_NAMES[month - 1]} {year}
        </span>
        <button onClick={next} className="px-3 py-1.5 border rounded-lg hover:bg-gray-50 text-sm">Next ›</button>
      </PageHeader>

      <div className="flex items-center gap-4 mb-3 text-xs">
        {Object.entries(TYPE_LABELS).map(([k, label]) => (
          <span key={k} className="flex items-center gap-1">
            <span className={`inline-block w-3 h-3 rounded ${TYPE_STYLES[k]}`} />
            {label}
          </span>
        ))}
      </div>

      {error && (
        <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>
      )}

      <div className="bg-white shadow rounded-lg overflow-hidden">
        <div className="grid grid-cols-7 bg-gray-50 border-b border-gray-200">
          {WEEKDAYS.map((w) => (
            <div key={w} className="px-2 py-2 text-xs font-medium text-gray-600 text-center">{w}</div>
          ))}
        </div>
        <div className="grid grid-cols-7">
          {cells.map((d, idx) => (
            <div key={idx} className="min-h-[6rem] border-b border-r border-gray-100 p-1 align-top">
              {d && (
                <>
                  <div className={`text-xs mb-1 ${isToday(d) ? 'font-bold text-white bg-gray-900 rounded-full w-6 h-6 flex items-center justify-center' : 'text-gray-500'}`}>
                    {d}
                  </div>
                  <div className="space-y-1">
                    {(eventsByDay[d] || []).map((e, i) => (
                      <button
                        key={i}
                        type="button"
                        onClick={() => setSelected(e)}
                        title="View details"
                        className={`block w-full text-left text-[10px] px-1 py-0.5 rounded truncate cursor-pointer hover:brightness-95 ${TYPE_STYLES[e.type]}`}>
                        {e.label}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      </div>
      {loading && <p className="text-sm text-gray-500 mt-3">Loading…</p>}

      {selected && (() => {
        const e = selected;
        const m = e.meta || {};
        const isInterview = e.type === 'interview';
        return (
          <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-[60]"
            onMouseDown={() => setSelected(null)}>
            <div className="bg-white rounded-2xl shadow-xl w-full max-w-md overflow-hidden"
              onMouseDown={(ev) => ev.stopPropagation()}>
              {/* Header */}
              <div className="px-5 pt-5 pb-4 border-b border-gray-100">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 mb-1.5">
                      <span className={`inline-block text-[10px] font-medium rounded-full px-2 py-0.5 ${TYPE_STYLES[e.type]}`}>
                        {TYPE_LABELS[e.type]}
                      </span>
                    </div>
                    <h2 className="text-lg font-semibold text-gray-900 break-words leading-snug">{e.label}</h2>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {new Date(year, month - 1, e.day).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
                    </p>
                  </div>
                  <button type="button" onClick={() => setSelected(null)}
                    className="shrink-0 text-gray-400 hover:text-gray-700 rounded-lg p-1 -mr-1 hover:bg-gray-100">
                    <FiX size={18} />
                  </button>
                </div>
              </div>

              {/* Details */}
              <div className="px-5 py-4 space-y-2">
                {detailRows(e).map(([k, v]) => (
                  <div key={k} className="flex gap-3 text-sm">
                    <span className="w-24 shrink-0 text-gray-400">{k}</span>
                    <span className="text-gray-800 break-words">{v}</span>
                  </div>
                ))}
                {detailRows(e).length === 0 && (
                  <p className="text-sm text-gray-400">No further details.</p>
                )}
              </div>

              {/* Interview actions */}
              {isInterview && (m.hasResume || m.meetingLink) && (
                <div className="px-5 pb-5 pt-1 flex items-center gap-2">
                  {m.hasResume && (
                    <button type="button" onClick={() => openResume(m.candidateId)} disabled={resumeBusy}
                      className="inline-flex items-center gap-2 px-3.5 py-2 rounded-xl border border-gray-200 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60">
                      <FiFileText size={15} />
                      {resumeBusy ? 'Opening…' : 'Resume'}
                    </button>
                  )}
                  {m.meetingLink && (
                    <a href={m.meetingLink} target="_blank" rel="noreferrer"
                      className="ml-auto inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-gray-900 text-white text-sm font-medium shadow-sm hover:bg-gray-800 transition-colors">
                      <FiVideo size={15} />
                      Join meeting
                    </a>
                  )}
                </div>
              )}
            </div>
          </div>
        );
      })()}
    </div>
  );
}
