import { useEffect, useMemo, useState } from 'react';
import api from '../api/client';

// GitHub-style attendance heatmap of the caller's last ~12 months. Self-contained:
// fetches /attendance/me/heatmap and renders a grid of weeks (columns) × weekdays
// (rows), colouring each day by its classification.

const EMPTY = '#ebedf0';
// Day classifications and their colours / legend labels.
const CATEGORIES = [
  { key: 'absent', label: 'Absent', color: '#ef4444' },
  { key: 'full', label: 'Full day', color: '#16a34a' },
  { key: 'half', label: 'Half day', color: '#f59e0b' },
  { key: 'leave', label: 'Leave', color: '#8b5cf6' },
  { key: 'compoff', label: 'Comp off', color: '#0ea5e9' },
];
const COLOR_BY_CAT = Object.fromEntries(CATEGORIES.map((c) => [c.key, c.color]));
const LABEL_BY_CAT = Object.fromEntries(CATEGORIES.map((c) => [c.key, c.label]));
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const colorFor = (rec) => (rec && COLOR_BY_CAT[rec.category]) || EMPTY;

export default function AttendanceHeatmap({ days = 365 }) {
  const [byDate, setByDate] = useState({});
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const { data } = await api.get(`/attendance/me/heatmap?days=${days}`);
        const map = {};
        for (const d of data.days || []) map[d.date] = d;
        if (active) setByDate(map);
      } catch { /* leave empty */ }
      finally { if (active) setLoaded(true); }
    })();
    return () => { active = false; };
  }, [days]);

  // Build weeks (columns), each a Sunday→Saturday run of dates, ending today.
  const { weeks, monthLabels } = useMemo(() => {
    const end = new Date(); end.setHours(0, 0, 0, 0);
    const start = new Date(end); start.setDate(start.getDate() - (days - 1));
    start.setDate(start.getDate() - start.getDay()); // back up to Sunday

    const cols = [];
    const labels = [];
    let cur = new Date(start);
    let lastMonth = -1;
    while (cur <= end) {
      const week = [];
      let labelForWeek = '';
      for (let i = 0; i < 7; i += 1) {
        if (cur <= end && cur >= start) {
          const key = ymd(cur);
          week.push({ key, date: new Date(cur), rec: byDate[key] });
          if (week.length === 1 && cur.getMonth() !== lastMonth && cur.getDate() <= 7) {
            labelForWeek = MONTHS[cur.getMonth()];
            lastMonth = cur.getMonth();
          }
        } else {
          week.push(null);
        }
        cur.setDate(cur.getDate() + 1);
      }
      cols.push(week);
      labels.push(labelForWeek);
    }
    return { weeks: cols, monthLabels: labels };
  }, [byDate, days]);

  const CELL = 11, GAP = 3;
  const fmtTip = (cell) => {
    const dStr = cell.date.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
    return `${dStr} — ${cell.rec ? LABEL_BY_CAT[cell.rec.category] : 'No record'}`;
  };

  return (
    <div>
      <div className="flex items-center justify-end mb-2">
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-gray-500">
          {!loaded && <span className="text-gray-400 mr-1">Loading…</span>}
          {CATEGORIES.map((c) => (
            <span key={c.key} className="flex items-center gap-1">
              <span className="inline-block rounded-sm" style={{ width: CELL, height: CELL, background: c.color }} />
              {c.label}
            </span>
          ))}
        </span>
      </div>
      <div className="overflow-x-auto">
        <div className="inline-block">
          {/* month labels */}
          <div className="flex" style={{ gap: GAP, marginLeft: 2 }}>
            {monthLabels.map((m, i) => (
              <div key={i} className="text-[9px] text-gray-400 whitespace-nowrap" style={{ width: CELL }}>{m}</div>
            ))}
          </div>
          {/* week columns */}
          <div className="flex" style={{ gap: GAP, marginTop: 2 }}>
            {weeks.map((week, wi) => (
              <div key={wi} className="flex flex-col" style={{ gap: GAP }}>
                {week.map((cell, di) => (
                  <div
                    key={di}
                    title={cell ? fmtTip(cell) : undefined}
                    className="rounded-sm"
                    style={{ width: CELL, height: CELL, background: cell ? colorFor(cell.rec) : 'transparent' }}
                  />
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
