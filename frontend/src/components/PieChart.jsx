import { useState } from 'react';

// Lightweight dependency-free donut/pie chart with hover interactivity:
// hovering a slice (or legend row) highlights it, dims the rest, and shows that
// slice's detail in the centre. props: data = [{ label, value, color }], size.
export default function PieChart({ data = [], size = 180 }) {
  const [active, setActive] = useState(null);

  const total = data.reduce((sum, d) => sum + (d.value || 0), 0);
  const r = size / 2;
  const stroke = size * 0.22; // donut thickness
  // Leave headroom so the active slice (stroke + 6) and the drop shadow never
  // get clipped at the SVG edge on hover.
  const radius = r - stroke / 2 - 6;
  const circ = 2 * Math.PI * radius;

  let offset = 0;
  const segments = total > 0
    ? data.map((d, i) => {
        if (!(d.value > 0)) return null;
        const frac = d.value / total;
        const seg = { ...d, i, frac, dash: frac * circ, offset };
        offset += frac * circ;
        return seg;
      }).filter(Boolean)
    : [];

  const shown = active != null ? data[active] : null;
  const centerMain = shown ? shown.value : total;
  const centerSub = shown ? shown.label : 'total';

  return (
    <div className="pie-chart flex items-center justify-center gap-6 flex-wrap py-2">
      <svg
        width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0"
        style={{ filter: 'drop-shadow(0 4px 10px rgba(15,23,42,.18))', overflow: 'visible' }}
      >
        {/* track */}
        <circle cx={r} cy={r} r={radius} fill="none" stroke="currentColor" strokeWidth={stroke} className="text-gray-100" />
        {/* segments */}
        <g transform={`rotate(-90 ${r} ${r})`}>
          {segments.map((s) => (
            <circle
              key={s.i}
              className="pie-seg"
              cx={r} cy={r} r={radius} fill="none"
              stroke={s.color}
              strokeWidth={active === s.i ? stroke + 6 : stroke}
              strokeDasharray={`${s.dash} ${circ - s.dash}`}
              strokeDashoffset={-s.offset}
              strokeLinecap="butt"
              opacity={active != null && active !== s.i ? 0.35 : 1}
              onMouseEnter={() => setActive(s.i)}
              onMouseLeave={() => setActive(null)}
            />
          ))}
        </g>
        {/* center detail */}
        <text x={r} y={r - 2} textAnchor="middle" className="fill-gray-900" style={{ fontSize: size * 0.2, fontWeight: 700 }}>
          {centerMain}
        </text>
        <text x={r} y={r + size * 0.14} textAnchor="middle" className="fill-gray-500" style={{ fontSize: size * 0.078 }}>
          {centerSub}
        </text>
      </svg>

      <ul className="space-y-1 text-sm min-w-[8rem]">
        {data.map((d, i) => (
          <li
            key={i}
            className="pie-legend-row flex items-center gap-2 px-2 py-1"
            style={{ opacity: active != null && active !== i ? 0.5 : 1 }}
            onMouseEnter={() => setActive(i)}
            onMouseLeave={() => setActive(null)}
          >
            <span className="inline-block w-3 h-3 rounded-sm shrink-0" style={{ backgroundColor: d.color }} />
            <span className="text-gray-700">{d.label}</span>
            <span className="ml-auto font-medium text-gray-900">{d.value}</span>
            <span className="text-xs text-gray-400 w-10 text-right">
              {total > 0 ? Math.round(((d.value || 0) / total) * 100) : 0}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
