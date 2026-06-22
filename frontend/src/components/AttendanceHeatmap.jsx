import { useEffect, useMemo, useState } from 'react';
import api from '../api/client';

// Attendance heatmap of the caller's last ~12 months, segregated into month
// blocks (each month = its own column-group with a label), centered. Each day is
// coloured by its classification.

const EMPTY = '#ebedf0';
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

const CELL = 12, GAP = 3;

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

  const fmtTip = (cell) => {
    const dStr = cell.date.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
    if (cell.future) return dStr;
    return `${dStr} — ${cell.rec ? LABEL_BY_CAT[cell.rec.category] : 'No record'}`;
  };

  return (
    <div>
      <div className="flex items-center justify-center flex-wrap gap-x-4 gap-y-1 mb-3" style={{ fontSize: 11, color: '#4b5563' }}>
        {!loaded && <span className="text-gray-400">Loading…</span>}
        {CATEGORIES.map((c) => (
          <span key={c.key} className="flex items-center gap-1.5">
            <span className="inline-block rounded-sm" style={{ width: CELL, height: CELL, background: c.color }} />
            {c.label}
          </span>
        ))}
      </div>

      <div className="overflow-x-auto">
        <div className="flex gap-3 w-max mx-auto">
          {months.map((mo) => (
            <div key={`${mo.label}-${mo.year}`} className="flex flex-col">
              <div className="text-[10px] text-gray-400 mb-1 text-center">{mo.label}</div>
              <div className="flex" style={{ gap: GAP }}>
                {mo.cols.map((wcol, ci) => (
                  <div key={ci} className="flex flex-col" style={{ gap: GAP }}>
                    {wcol.map((cell, di) => (
                      <div
                        key={di}
                        title={cell ? fmtTip(cell) : undefined}
                        className="rounded-sm"
                        style={{
                          width: CELL,
                          height: CELL,
                          background: cell && !cell.future ? colorFor(cell.rec) : 'transparent',
                        }}
                      />
                    ))}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
