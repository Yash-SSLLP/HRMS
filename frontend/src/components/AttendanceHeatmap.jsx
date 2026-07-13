import { useEffect, useMemo, useState } from 'react';
import api from '../api/client';

// Attendance heatmap of the trailing ~12 months, split into month blocks.
//   • Personal mode (default): each day coloured by the caller's classification.
//   • Org mode (org=true, admins): each day shaded by how many employees were
//     present — darker = more present — with a hover card showing the breakdown.

const EMPTY = '#ebedf0';
// Day-type tints used to fill otherwise-blank cells so weekends/holidays/comp-off
// days are visible rather than looking like plain "no data" gaps.
const WEEKEND = '#cdd6f4'; // Sunday — soft periwinkle
const HOLIDAY = '#ffd8a8'; // holiday — soft amber
const CATEGORIES = [
  { key: 'absent', label: 'Absent', color: '#ef4444' },
  { key: 'full', label: 'Full day', color: '#16a34a' },
  { key: 'late', label: 'Late', color: '#ec4899' },
  { key: 'half', label: 'Half day', color: '#f59e0b' },
  { key: 'leave', label: 'Leave', color: '#8b5cf6' },
  { key: 'compoff', label: 'Comp off', color: '#0ea5e9' },
];
const COLOR_BY_CAT = Object.fromEntries(CATEGORIES.map((c) => [c.key, c.color]));
const LABEL_BY_CAT = Object.fromEntries(CATEGORIES.map((c) => [c.key, c.label]));
// A late arrival is a full day flagged `late` — surface it as its own colour.
const effCat = (rec) => (rec && rec.category === 'full' && rec.late ? 'late' : rec?.category);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// GitHub-style green ramp for the org "present count" intensity.
const ORG_RAMP = ['#9be9a8', '#40c463', '#30a14e', '#216e39'];
const orgColor = (present, max) => {
  if (!present) return EMPTY;
  if (max <= 0) return ORG_RAMP[0];
  const r = present / max;
  if (r <= 0.25) return ORG_RAMP[0];
  if (r <= 0.5) return ORG_RAMP[1];
  if (r <= 0.75) return ORG_RAMP[2];
  return ORG_RAMP[3];
};

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const CELL = 12, GAP = 3;

// org=true renders the aggregate ("how many present/late/on-leave") view.
// scope selects whose employees it covers: 'org' = everyone (HR/Admin), 'team' =
// the caller's direct reports (Manager). Aggregate cells are clickable → a modal
// listing the employees behind each day's counts.
export default function AttendanceHeatmap({ days = 365, org = false, scope = 'org' }) {
  const [byDate, setByDate] = useState({});
  const [maxPresent, setMaxPresent] = useState(0);
  const [total, setTotal] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [tip, setTip] = useState(null); // org hover card: { x, y, cell }
  const [dayModal, setDayModal] = useState(null); // clicked aggregate cell: { date }
  const [holidays, setHolidays] = useState(() => new Map()); // ymd -> holiday name

  const heatmapBase = scope === 'team' ? '/manager/attendance' : '/attendance/org';
  const dayEndpoint = scope === 'team' ? '/manager/attendance/day' : '/attendance/org/day';

  // Holidays (for marking those blocks) — fetched once. Keyed with the SAME
  // local-timezone ymd() the grid uses, so a holiday lines up with its cell.
  useEffect(() => {
    api.get('/holidays')
      .then(({ data }) => {
        const m = new Map();
        for (const h of data.holidays || []) {
          if (h.date) m.set(ymd(new Date(h.date)), h.name || 'Holiday');
        }
        setHolidays(m);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    let active = true;
    setLoaded(false);
    (async () => {
      try {
        const url = org ? `${heatmapBase}/heatmap?days=${days}` : `/attendance/me/heatmap?days=${days}`;
        const { data } = await api.get(url);
        const map = {};
        for (const d of data.days || []) map[d.date] = d;
        if (active) {
          setByDate(map);
          setMaxPresent(data.maxPresent || 0);
          setTotal(data.totalEmployees || 0);
        }
      } catch { /* leave empty */ }
      finally { if (active) setLoaded(true); }
    })();
    return () => { active = false; };
  }, [days, org, heatmapBase]);

  // Build the trailing 12 month-blocks; each is weeks(columns) × 7 weekday rows.
  const months = useMemo(() => {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const list = [];
    const cursor = new Date(today.getFullYear(), today.getMonth() - 11, 1);
    for (let i = 0; i < 12; i += 1) {
      const y = cursor.getFullYear();
      const m = cursor.getMonth();
      const daysInMonth = new Date(y, m + 1, 0).getDate();
      const cols = [];
      let col = new Array(7).fill(null);
      for (let d = 1; d <= daysInMonth; d += 1) {
        const date = new Date(y, m, d);
        const dow = date.getDay();
        col[dow] = { key: ymd(date), date, rec: byDate[ymd(date)], future: date > today };
        if (dow === 6 || d === daysInMonth) { cols.push(col); col = new Array(7).fill(null); }
      }
      list.push({ label: MONTHS[m], year: y, cols });
      cursor.setMonth(cursor.getMonth() + 1);
    }
    return list;
  }, [byDate]);

  const cellColor = (cell) => {
    if (!cell || cell.future) return 'transparent';
    const isHoliday = holidays.has(cell.key);
    const isSunday = cell.date.getDay() === 0;
    if (org) {
      const present = cell.rec?.present || 0;
      if (present > 0) return orgColor(present, maxPresent);       // people worked → green ramp
      if ((cell.rec?.compoff || 0) > 0) return COLOR_BY_CAT.compoff; // comp-off taken
      if (isHoliday) return HOLIDAY;
      if (isSunday) return WEEKEND;
      return EMPTY;
    }
    if (cell.rec && COLOR_BY_CAT[effCat(cell.rec)]) return COLOR_BY_CAT[effCat(cell.rec)];
    if (isHoliday) return HOLIDAY;
    if (isSunday) return WEEKEND;
    return EMPTY;
  };

  const dateLabel = (d) => d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  // Time-of-day displays are 12-hour AM/PM across the portal.
  const fmtTime = (iso) => (iso ? new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true }) : '-');

  return (
    <div>
      <div className="flex items-center justify-center flex-wrap gap-x-4 gap-y-1 mb-3" style={{ fontSize: 11, color: '#4b5563' }}>
        {!loaded && <span className="text-gray-400">Loading…</span>}
        {org ? (
          <span className="flex items-center gap-1.5">
            Fewer present
            <span className="inline-block rounded-sm" style={{ width: CELL, height: CELL, background: EMPTY }} />
            {ORG_RAMP.map((c) => (
              <span key={c} className="inline-block rounded-sm" style={{ width: CELL, height: CELL, background: c }} />
            ))}
            More present
          </span>
        ) : (
          CATEGORIES.map((c) => (
            <span key={c.key} className="flex items-center gap-1.5">
              <span className="inline-block rounded-sm" style={{ width: CELL, height: CELL, background: c.color }} />
              {c.label}
            </span>
          ))
        )}
        {/* Day-type markers (shown in both modes). Comp-off is already in the
            personal legend via CATEGORIES, so only add it for the org view. */}
        {org && (
          <span className="flex items-center gap-1.5">
            <span className="inline-block rounded-sm" style={{ width: CELL, height: CELL, background: COLOR_BY_CAT.compoff }} />
            Comp off
          </span>
        )}
        <span className="flex items-center gap-1.5">
          <span className="inline-block rounded-sm" style={{ width: CELL, height: CELL, background: WEEKEND }} />
          Sunday
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block rounded-sm" style={{ width: CELL, height: CELL, background: HOLIDAY }} />
          Holiday
        </span>
      </div>

      <div className="overflow-x-auto">
        <div className="flex gap-3 w-max mx-auto">
          {months.map((mo) => (
            <div key={`${mo.label}-${mo.year}`} className="flex flex-col">
              <div className="text-[10px] text-gray-400 mb-1 text-center">{mo.label}</div>
              <div className="flex" style={{ gap: GAP }}>
                {mo.cols.map((wcol, ci) => (
                  <div key={ci} className="flex flex-col" style={{ gap: GAP }}>
                    {wcol.map((cell, di) => {
                      const interactive = cell && !cell.future;
                      // In the aggregate view, a day with any records is clickable
                      // to open the per-employee breakdown modal.
                      const clickable = org && interactive && !!cell.rec;
                      return (
                        <div
                          key={di}
                          onMouseEnter={interactive ? (e) => setTip({ x: e.clientX, y: e.clientY, cell }) : undefined}
                          onMouseMove={interactive ? (e) => setTip((t) => (t ? { ...t, x: e.clientX, y: e.clientY } : t)) : undefined}
                          onMouseLeave={interactive ? () => setTip(null) : undefined}
                          onClick={clickable ? () => { setTip(null); setDayModal({ date: cell.key }); } : undefined}
                          className={`rounded-sm ${clickable ? 'cursor-pointer' : ''}`}
                          style={{ width: CELL, height: CELL, background: cellColor(cell) }}
                        />
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      {tip && (
        <div
          className="fixed z-50 pointer-events-none bg-gray-900 text-white text-xs rounded-lg shadow-lg px-3 py-2"
          style={{ left: tip.x + 12, top: tip.y + 12, minWidth: 160 }}
        >
          <div className="font-semibold mb-1">{dateLabel(tip.cell.date)}</div>
          {holidays.has(tip.cell.key) && (
            <div className="text-amber-300 mb-0.5">Holiday · {holidays.get(tip.cell.key)}</div>
          )}
          {org ? (
            tip.cell.rec ? (
              <div className="space-y-0.5">
                <div className="font-medium">
                  {tip.cell.rec.present} present{total ? ` / ${total}` : ''}
                </div>
                <div className="text-pink-300">Late: {tip.cell.rec.late || 0}</div>
                <div className="text-gray-300">Full day: {tip.cell.rec.full}</div>
                <div className="text-gray-300">Half day: {tip.cell.rec.half}</div>
                <div className="text-gray-300">Leave: {tip.cell.rec.leave}</div>
                <div className="text-gray-300">Comp off: {tip.cell.rec.compoff}</div>
                <div className="text-gray-300">Absent: {tip.cell.rec.absent}</div>
                <div className="text-gray-400 italic pt-0.5">Click for names</div>
              </div>
            ) : (
              <div className="text-gray-300">
                {holidays.has(tip.cell.key) ? 'No one present' : tip.cell.date.getDay() === 0 ? 'Sunday' : 'No attendance recorded'}
              </div>
            )
          ) : tip.cell.rec ? (
            <div className="space-y-0.5">
              <div className="font-medium flex items-center gap-1.5">
                <span className="inline-block rounded-sm" style={{ width: 9, height: 9, background: COLOR_BY_CAT[effCat(tip.cell.rec)] }} />
                {LABEL_BY_CAT[effCat(tip.cell.rec)]}
                {tip.cell.rec.leaveType ? ` · ${tip.cell.rec.leaveType}` : ''}
                {tip.cell.rec.halfDaySession && tip.cell.rec.halfDaySession !== true
                  ? ` (${tip.cell.rec.halfDaySession === 'FirstHalf' ? '1st half' : '2nd half'})`
                  : ''}
              </div>
              {(tip.cell.rec.checkIn || tip.cell.rec.checkOut) && (
                <>
                  <div className="text-gray-300">Login: {fmtTime(tip.cell.rec.checkIn)}</div>
                  <div className="text-gray-300">Logout: {fmtTime(tip.cell.rec.checkOut)}</div>
                </>
              )}
              {tip.cell.rec.noPunchOut && <div className="text-amber-300">Missing punch-out</div>}
              {tip.cell.rec.hoursWorked ? (
                <div className="text-gray-300">Hours: {tip.cell.rec.hoursWorked}</div>
              ) : null}
              {tip.cell.rec.wfh && <div className="text-sky-300">Work from home</div>}
              {tip.cell.rec.remarks && <div className="text-gray-400 italic">{tip.cell.rec.remarks}</div>}
            </div>
          ) : (
            <div className="text-gray-300">
              {holidays.has(tip.cell.key)
                ? 'Holiday'
                : tip.cell.date.getDay() === 0
                  ? 'Weekly off (Sunday)'
                  : 'No record'}
            </div>
          )}
        </div>
      )}

      {dayModal && (
        <DayDetailsModal date={dayModal.date} endpoint={dayEndpoint} onClose={() => setDayModal(null)} />
      )}
    </div>
  );
}

// Click-through breakdown for one aggregate day: who was late / on leave /
// present / etc., by name. Fetches from the org or team day-details endpoint.
function DayDetailsModal({ date, endpoint, onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    setLoading(true); setError('');
    api.get(`${endpoint}?date=${date}`)
      .then(({ data: d }) => { if (active) setData(d); })
      .catch((e) => { if (active) setError(e.response?.data?.message || 'Failed to load day details'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [date, endpoint]);

  const fmtTime = (iso) => (iso ? new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true }) : null);
  const dateLabel = new Date(`${date}T00:00:00+05:30`).toLocaleDateString('en-IN', {
    weekday: 'long', day: 'numeric', month: 'short', year: 'numeric',
  });

  const Section = ({ title, color, people, render }) =>
    people && people.length > 0 ? (
      <div className="mb-4">
        <div className="flex items-center gap-2 mb-1.5">
          <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: color }} />
          <span className="font-semibold text-sm text-gray-700">{title}</span>
          <span className="text-xs text-gray-400">({people.length})</span>
        </div>
        <ul className="divide-y divide-gray-100 rounded-lg border border-gray-100">
          {people.map((p, i) => (
            <li key={i} className="flex items-center justify-between gap-3 px-3 py-1.5 text-sm">
              <span className="text-gray-800 truncate">
                {p.name}
                {p.designation ? <span className="text-gray-400 text-xs ml-2">{p.designation}</span> : null}
              </span>
              {render && render(p) ? <span className="text-xs text-gray-500 shrink-0">{render(p)}</span> : null}
            </li>
          ))}
        </ul>
      </div>
    ) : null;

  const empty = data && ['present', 'late', 'half', 'leave', 'compoff', 'absent'].every((k) => (data[k] || []).length === 0);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/40" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[82vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-4 px-5 py-4 border-b border-gray-100">
          <div>
            <div className="font-semibold text-gray-900">{dateLabel}</div>
            {data && (
              <div className="text-xs text-gray-500 mt-0.5">
                {data.counts.present} present · <span className="text-pink-600">{data.counts.late} late</span> · <span className="text-violet-600">{data.counts.leave} on leave</span> · {data.counts.absent} absent
                {data.counts.total ? ` · ${data.counts.total} total` : ''}
              </div>
            )}
          </div>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-700 text-2xl leading-none -mt-1">×</button>
        </div>
        <div className="px-5 py-4 overflow-y-auto">
          {loading && <div className="text-sm text-gray-400">Loading…</div>}
          {error && <div className="text-sm text-red-600">{error}</div>}
          {data && !loading && (
            empty ? (
              <div className="text-sm text-gray-400 italic">No attendance recorded for this day.</div>
            ) : (
              <>
                <Section title="Late" color="#ec4899" people={data.late} render={(p) => fmtTime(p.checkIn)} />
                <Section title="On leave" color="#8b5cf6" people={data.leave} render={(p) => (p.leaveType ? `${p.leaveType}${p.half ? ' · half' : ''}` : null)} />
                <Section title="Half day" color="#f59e0b" people={data.half} render={(p) => fmtTime(p.checkIn)} />
                <Section title="Comp off" color="#0ea5e9" people={data.compoff} />
                <Section title="Absent" color="#ef4444" people={data.absent} />
                <Section title="Present (full day)" color="#16a34a" people={data.present} render={(p) => (p.late ? 'late' : fmtTime(p.checkIn))} />
              </>
            )
          )}
        </div>
      </div>
    </div>
  );
}
