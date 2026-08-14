import { useState } from 'react';

// Lightweight dependency-free donut chart with hover interactivity: hovering a
// slice (or its legend row) highlights it, dims the rest, and shows that slice's
// detail in the centre. props: data = [{ label, value, color }], size.
//
// Three deliberate choices, all from the same rule — the data is the only thing
// allowed to be loud:
//
//  1. **A thin ring, not a fat one.** A thick band of saturated colour reads loud
//     and unrefined at dashboard scale; saturated fills belong on small marks and
//     accents. The ring is ~13% of the diameter.
//  2. **A gap, not a border, separates segments.** Touching fills are separated by
//     a 2px gap that lets the card surface through — which is why no track circle
//     is drawn behind the data (it would fill the gaps with grey instead). The
//     track returns only for the empty state. A border would add ink that isn't data.
//  3. **Geometry never moves on hover.** The old version grew the hovered slice's
//     stroke, which made the whole ring twitch under the cursor. Emphasis is
//     carried by dimming the others, and by the centre read-out.
//
// The legend doubles as the chart's accessible table: every segment's label,
// value and share are printed as text, so nothing is reachable only by hovering.
export default function PieChart({ data = [], size = 180 }) {
  const [active, setActive] = useState(null);

  const total = data.reduce((sum, d) => sum + (d.value || 0), 0);
  const r = size / 2;
  const stroke = Math.round(size * 0.13); // thin ring — see note 1 above
  const radius = r - stroke / 2 - 2;      // 2px breathing room inside the viewBox
  const circ = 2 * Math.PI * radius;

  // The surface gap between touching segments (note 2). A lone full-circle
  // segment gets none — a 2px notch in an otherwise unbroken ring reads as a
  // rendering artefact rather than as a separator.
  const GAP = 2;

  const live = data.filter((d) => d.value > 0);
  const gap = live.length > 1 ? GAP : 0;

  let offset = 0;
  const segments = total > 0
    ? data.map((d, i) => {
        if (!(d.value > 0)) return null;
        const frac = d.value / total;
        const full = frac * circ;
        // Shorten each arc by the gap rather than moving its start, so every
        // segment still begins at its true boundary.
        const seg = { ...d, i, frac, dash: Math.max(1, full - gap), offset };
        offset += full;
        return seg;
      }).filter(Boolean)
    : [];

  const shown = active != null ? data[active] : null;
  const centerMain = shown ? shown.value : total;
  const centerSub = shown ? shown.label : 'total';

  const pct = (v) => (total > 0 ? Math.round(((v || 0) / total) * 100) : 0);

  return (
    <div className="pie-chart flex items-center justify-center gap-7 flex-wrap py-2">
      <svg
        width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0"
        role="img"
        aria-label={`${total} total. ${data.map((d) => `${d.label} ${d.value}`).join(', ')}.`}
      >
        {/* Track — only when there is nothing to plot. With data, the gaps
            between segments must show the card surface, not a grey ring. */}
        {segments.length === 0 && (
          <circle
            cx={r} cy={r} r={radius} fill="none"
            stroke="currentColor" strokeWidth={stroke} className="text-gray-100"
          />
        )}

        <g transform={`rotate(-90 ${r} ${r})`}>
          {segments.map((s) => (
            <circle
              key={s.i}
              className="pie-seg"
              cx={r} cy={r} r={radius} fill="none"
              stroke={s.color}
              strokeWidth={stroke}
              strokeDasharray={`${s.dash} ${circ - s.dash}`}
              strokeDashoffset={-s.offset}
              strokeLinecap="butt"
              opacity={active != null && active !== s.i ? 0.28 : 1}
              onMouseEnter={() => setActive(s.i)}
              onMouseLeave={() => setActive(null)}
            />
          ))}
        </g>

        {/* Centre read-out. Proportional figures, not tabular: at this size
            equal-width digits make a number like "121" look loose. */}
        <text
          x={r} y={r - 1} textAnchor="middle" className="fill-gray-900"
          style={{ fontSize: size * 0.26, fontWeight: 700, letterSpacing: '-0.02em' }}
        >
          {centerMain}
        </text>
        <text
          x={r} y={r + size * 0.15} textAnchor="middle" className="fill-gray-500"
          style={{ fontSize: size * 0.072, letterSpacing: '0.04em' }}
        >
          {centerSub}
        </text>
      </svg>

      <ul className="space-y-0.5 min-w-[10rem]">
        {data.map((d, i) => {
          const dim = active != null && active !== i;
          return (
            // The row's hover tint is left to .pie-legend-row in index.css —
            // it is accent-tinted and theme-aware, so a Tailwind grey here would
            // both clash with it and stay grey in dark mode. Hovering a SEGMENT
            // feeds back through the dimming below and the centre read-out.
            <li
              key={i}
              className="pie-legend-row flex items-center gap-2.5 px-2 py-1.5"
              style={{ opacity: dim ? 0.45 : 1, transition: 'opacity .15s ease' }}
              onMouseEnter={() => setActive(i)}
              onMouseLeave={() => setActive(null)}
            >
              <span
                className="inline-block w-2.5 h-2.5 rounded-full shrink-0"
                style={{ backgroundColor: d.color }}
              />
              <span className="text-sm text-gray-600">{d.label}</span>
              {/* Values and shares line up in columns, so these DO take
                  tabular figures — the opposite of the centre number. */}
              <span className="ml-auto text-sm font-semibold text-gray-900 tabular-nums">
                {d.value}
              </span>
              <span className="text-xs text-gray-400 w-9 text-right tabular-nums">
                {pct(d.value)}%
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
