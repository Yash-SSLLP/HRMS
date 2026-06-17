// Lightweight dependency-free donut/pie chart.
// props: data = [{ label, value, color }], size (px)
export default function PieChart({ data = [], size = 180 }) {
  const total = data.reduce((sum, d) => sum + (d.value || 0), 0);
  const r = size / 2;
  const stroke = size * 0.22; // donut thickness
  const radius = r - stroke / 2;
  const circ = 2 * Math.PI * radius;

  let offset = 0;
  const segments = total > 0
    ? data
        .filter((d) => d.value > 0)
        .map((d) => {
          const frac = d.value / total;
          const seg = { ...d, frac, dash: frac * circ, offset };
          offset += frac * circ;
          return seg;
        })
    : [];

  return (
    <div className="flex items-center gap-5 flex-wrap">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0">
        {/* track */}
        <circle
          cx={r} cy={r} r={radius} fill="none"
          stroke="currentColor" strokeWidth={stroke}
          className="text-gray-100"
        />
        {/* segments */}
        <g transform={`rotate(-90 ${r} ${r})`}>
          {segments.map((s, i) => (
            <circle
              key={i}
              cx={r} cy={r} r={radius} fill="none"
              stroke={s.color} strokeWidth={stroke}
              strokeDasharray={`${s.dash} ${circ - s.dash}`}
              strokeDashoffset={-s.offset}
              strokeLinecap="butt"
            />
          ))}
        </g>
        {/* center total */}
        <text x={r} y={r - 4} textAnchor="middle" className="fill-gray-900" style={{ fontSize: size * 0.2, fontWeight: 700 }}>
          {total}
        </text>
        <text x={r} y={r + size * 0.13} textAnchor="middle" className="fill-gray-500" style={{ fontSize: size * 0.08 }}>
          total
        </text>
      </svg>

      <ul className="space-y-1.5 text-sm min-w-[8rem]">
        {data.map((d, i) => (
          <li key={i} className="flex items-center gap-2">
            <span className="inline-block w-3 h-3 rounded-sm" style={{ backgroundColor: d.color }} />
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
