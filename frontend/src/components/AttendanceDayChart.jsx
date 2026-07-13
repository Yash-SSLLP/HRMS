import { useCallback, useRef, useState } from 'react';

// Combo chart for the daily attendance report.
//   • Two lines over a "time of day" Y axis: login (check-in) and logout (check-out).
//   • A bar at each day spanning from login → logout — its length is the total
//     present time, labelled with hours & minutes.
//   • Per-point labels show the actual login/logout clock time in the matching
//     line colour.
//
// props.days: [{ label, login, logout, present }] where login/logout are minutes
//   since midnight (or null) and present is total worked minutes (or null).
// props.compact: shrink everything (height, bands, fonts) and drop the dense
//   value labels — for embedding in a small dashboard card (values stay on hover).

const pad = (n) => String(n).padStart(2, '0');
// minutes since midnight → 12-hour clock time, e.g. 540 → "9:00 AM"
const hhmm = (m) => {
  const total = Math.round(m);
  const h24 = Math.floor(total / 60);
  const mm = total % 60;
  const ampm = h24 < 12 ? 'AM' : 'PM';
  const h12 = h24 % 12 || 12;
  return `${h12}:${pad(mm)} ${ampm}`;
};
const dur = (m) => {
  const h = Math.floor(m / 60);
  const mm = Math.round(m % 60);
  return mm ? `${h}h ${mm}m` : `${h}h`;
};

const LOGIN_COLOR = '#16a34a';   // green
const LOGOUT_COLOR = '#dc2626';  // red
const BAR_FILL = '#6366f1';      // indigo
const BAR_LABEL = '#4338ca';

// White halo behind label text so it stays legible over lines/bars/gridlines.
const halo = { paintOrder: 'stroke', stroke: '#fff', strokeWidth: 3, strokeLinejoin: 'round' };

export default function AttendanceDayChart({ days = [], height, compact = false }) {
  // Measure the wrapper so the chart can fill the full card width. Keeping the
  // viewBox width equal to the rendered width means scale stays 1:1, so labels
  // never balloon. Falls back to a sane default before the first measurement.
  const [wrapW, setWrapW] = useState(0);
  const roRef = useRef(null);
  const measureRef = useCallback((el) => {
    if (roRef.current) { roRef.current.disconnect(); roRef.current = null; }
    if (el && typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(([e]) => setWrapW(Math.round(e.contentRect.width)));
      ro.observe(el);
      roRef.current = ro;
      setWrapW(Math.round(el.getBoundingClientRect().width));
    }
  }, []);

  const times = days.flatMap((d) => [d.login, d.logout]).filter((v) => v != null);
  if (!times.length) {
    return <p className="text-sm text-gray-400 italic">No login/logout data for this period.</p>;
  }

  const showLabels = !compact;
  const n = days.length;
  const band = compact ? 30 : 52;
  const padL = compact ? 42 : 70;
  const padR = compact ? 12 : 18;
  const padT = compact ? 14 : 24;
  const padB = compact ? 26 : 40;
  const H = height || (compact ? 210 : 360);
  // In compact mode keep a wide-ish viewBox so a few data points still spread
  // across the card; the SVG is given an explicit pixel height (below) so it
  // never balloons to match the width's aspect ratio.
  // Non-compact: fill the measured card width (spreading the days across it);
  // fall back to 720 until measured, and grow past the card (→ scroll) only when
  // there are too many days to fit at the minimum per-day spacing.
  const W = Math.max(padL + padR + n * band, compact ? 600 : (wrapW || 720));
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  // Y domain: round out to whole hours with a little breathing room.
  const lo = Math.min(...times);
  const hi = Math.max(...times);
  const yMin = Math.max(0, Math.floor((lo - 30) / 60) * 60);
  let yMax = Math.min(24 * 60, Math.ceil((hi + 30) / 60) * 60);
  if (yMax <= yMin) yMax = yMin + 60;
  const range = yMax - yMin;
  const stepH = range <= 6 * 60 ? 1 : range <= 12 * 60 ? 2 : 3;
  const step = stepH * 60;

  const ticks = [];
  for (let t = yMin; t <= yMax; t += step) ticks.push(t);

  const x = (i) => padL + ((i + 0.5) / n) * plotW;
  const y = (v) => padT + plotH * (1 - (v - yMin) / range);

  // Build polyline segments, breaking the line wherever a day has no value.
  const segments = (key) => {
    const segs = [];
    let cur = [];
    days.forEach((d, i) => {
      if (d[key] != null) cur.push([x(i), y(d[key])]);
      else if (cur.length) { segs.push(cur); cur = []; }
    });
    if (cur.length) segs.push(cur);
    return segs;
  };

  const axisFont = compact ? 9 : 10;
  const ptR = compact ? 2.5 : 3.5;
  const bw = compact ? 9 : 16;

  return (
    <div className="w-full">
      <div className={`flex items-center justify-center gap-4 ${compact ? 'mb-1' : 'mb-2'}`} style={{ fontSize: compact ? 11 : 12, color: '#4b5563' }}>
        <span className="flex items-center gap-1.5"><span className="inline-block w-3.5 h-1.5 rounded-full" style={{ background: LOGIN_COLOR }} /> Login</span>
        <span className="flex items-center gap-1.5"><span className="inline-block w-3.5 h-1.5 rounded-full" style={{ background: LOGOUT_COLOR }} /> Logout</span>
        <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-3 rounded-sm" style={{ background: BAR_FILL, opacity: 0.35 }} /> Present</span>
      </div>

      <div ref={measureRef} className={compact ? '' : 'overflow-x-auto'}>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          width="100%"
          height={H}
          preserveAspectRatio="xMidYMid meet"
          style={compact ? { display: 'block', maxWidth: '100%' } : { minWidth: W, maxWidth: '100%' }}
          role="img" aria-label="Daily login and logout times with present-time bars">
          {/* gridlines + Y axis (time of day) */}
          {ticks.map((t, i) => (
            <g key={i}>
              <line x1={padL} y1={y(t)} x2={padL + plotW} y2={y(t)} stroke="currentColor" className="text-gray-200" strokeWidth="1" />
              <text x={padL - 6} y={y(t) + 3} textAnchor="end" className="fill-gray-400" style={{ fontSize: axisFont }}>{hhmm(t)}</text>
            </g>
          ))}
          {!compact && (
            <text x={12} y={padT + plotH / 2} transform={`rotate(-90 12 ${padT + plotH / 2})`} textAnchor="middle" className="fill-gray-500" style={{ fontSize: 11, fontWeight: 600 }}>
              Time of day
            </text>
          )}

          {/* present-time bars (login → logout) */}
          {days.map((d, i) => {
            if (d.login == null || d.logout == null || d.logout <= d.login) return null;
            const top = y(d.logout);
            const bottom = y(d.login);
            const present = d.present != null ? d.present : d.logout - d.login;
            return (
              <g key={`bar-${i}`}>
                <rect x={x(i) - bw / 2} y={top} width={bw} height={bottom - top} rx="3" fill={BAR_FILL} fillOpacity="0.22" stroke={BAR_FILL} strokeOpacity="0.35">
                  <title>{`${d.label} · Present ${dur(present)}`}</title>
                </rect>
                {showLabels && (
                  <text x={x(i)} y={(top + bottom) / 2 + 3} textAnchor="middle" style={{ fontSize: 9, fontWeight: 700, fill: BAR_LABEL, ...halo }}>
                    {dur(present)}
                  </text>
                )}
              </g>
            );
          })}

          {/* lines */}
          {[['login', LOGIN_COLOR], ['logout', LOGOUT_COLOR]].map(([key, color]) => (
            <g key={key}>
              {segments(key).map((seg, si) => (
                <polyline key={si} points={seg.map((p) => p.join(',')).join(' ')} fill="none" stroke={color} strokeWidth={compact ? 2 : 2.5} strokeLinejoin="round" strokeLinecap="round" />
              ))}
            </g>
          ))}

          {/* points + (full mode) coloured clock-time labels */}
          {days.map((d, i) => (
            <g key={`pt-${i}`}>
              {d.login != null && (
                <>
                  <circle cx={x(i)} cy={y(d.login)} r={ptR} fill={LOGIN_COLOR} stroke="#fff" strokeWidth="1.5">
                    <title>{`${d.label} · Login ${hhmm(d.login)}`}</title>
                  </circle>
                  {showLabels && (
                    <text x={x(i)} y={y(d.login) - 9} textAnchor="middle" style={{ fontSize: 9, fontWeight: 700, fill: LOGIN_COLOR, ...halo }}>{hhmm(d.login)}</text>
                  )}
                </>
              )}
              {d.logout != null && (
                <>
                  <circle cx={x(i)} cy={y(d.logout)} r={ptR} fill={LOGOUT_COLOR} stroke="#fff" strokeWidth="1.5">
                    <title>{`${d.label} · Logout ${hhmm(d.logout)}`}</title>
                  </circle>
                  {showLabels && (
                    <text x={x(i)} y={y(d.logout) + 16} textAnchor="middle" style={{ fontSize: 9, fontWeight: 700, fill: LOGOUT_COLOR, ...halo }}>{hhmm(d.logout)}</text>
                  )}
                </>
              )}
            </g>
          ))}

          {/* X axis (days) */}
          {days.map((d, i) => (
            <text key={`x-${i}`} x={x(i)} y={H - (compact ? 8 : 20)} textAnchor="middle" className="fill-gray-600" style={{ fontSize: axisFont }}>{d.label}</text>
          ))}
          {!compact && (
            <text x={padL + plotW / 2} y={H - 4} textAnchor="middle" className="fill-gray-500" style={{ fontSize: 11, fontWeight: 600 }}>Day</text>
          )}
        </svg>
      </div>
    </div>
  );
}
