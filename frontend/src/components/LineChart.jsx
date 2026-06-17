// Lightweight dependency-free SVG line chart. Supports one or many series.
//   <LineChart data={[{label,value}]} />                      // single (accent)
//   <LineChart series={[{ name, color, data:[{label,value}] }]} />  // multi
export default function LineChart({ data, series, height = 230 }) {
  const allSeries = series && series.length
    ? series
    : data
      ? [{ name: null, color: 'var(--accent)', data }]
      : [];

  if (!allSeries.length || !(allSeries[0].data || []).length) {
    return <p className="text-sm text-gray-400 italic">No data to chart</p>;
  }

  const labels = allSeries[0].data.map((d) => d.label);
  const n = labels.length;
  const multi = allSeries.length > 1;

  const W = Math.max(n * 54, 320);
  const H = height;
  const padL = 30, padR = 16, padT = 20, padB = 26;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const max = Math.max(1, ...allSeries.flatMap((s) => s.data.map((d) => d.value || 0)));

  const x = (i) => padL + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const y = (v) => padT + plotH - (v / max) * plotH;
  const ticks = [0, 0.5, 1].map((t) => ({ v: Math.round(max * t), gy: padT + plotH - t * plotH }));

  return (
    <div className="w-full">
      {multi && (
        <div className="flex items-center justify-center gap-5 mb-2 text-xs">
          {allSeries.map((s, i) => (
            <span key={i} className="flex items-center gap-1.5 text-gray-600">
              <span className="inline-block w-3.5 h-1.5 rounded-full" style={{ background: s.color }} />
              {s.name}
            </span>
          ))}
        </div>
      )}

      <div className="overflow-x-auto">
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ minWidth: W, maxWidth: '100%' }}>
          {/* gridlines + y labels */}
          {ticks.map((t, i) => (
            <g key={i}>
              <line x1={padL} y1={t.gy} x2={padL + plotW} y2={t.gy} stroke="currentColor" className="text-gray-200" strokeWidth="1" />
              <text x={padL - 6} y={t.gy + 3} textAnchor="end" className="fill-gray-400" style={{ fontSize: 9 }}>{t.v}</text>
            </g>
          ))}

          {/* x labels */}
          {labels.map((l, i) => (
            <text key={i} x={x(i)} y={H - 8} textAnchor="middle" className="fill-gray-500" style={{ fontSize: 10 }}>{l}</text>
          ))}

          {/* series */}
          {allSeries.map((s, si) => {
            const pts = s.data.map((d, i) => [x(i), y(d.value || 0)]);
            const line = pts.map((p) => p.join(',')).join(' ');
            const area = `${padL},${padT + plotH} ${line} ${padL + plotW},${padT + plotH}`;
            return (
              <g key={si}>
                {!multi && <polygon points={area} fill={s.color} fillOpacity="0.12" />}
                <polyline points={line} fill="none" stroke={s.color} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
                {s.data.map((d, i) => (
                  <g key={i}>
                    <circle className="line-pt" cx={x(i)} cy={y(d.value || 0)} r="3.5" fill={s.color} stroke="#fff" strokeWidth="1.5">
                      <title>{`${s.name ? s.name + ' · ' : ''}${d.label}: ${d.value}`}</title>
                    </circle>
                    {(d.value || 0) > 0 && (
                      <text
                        x={x(i)} y={y(d.value || 0) + (multi && si === 1 ? 14 : -8)}
                        textAnchor="middle" style={{ fontSize: 10, fontWeight: 600, fill: s.color }}
                      >
                        {d.value}
                      </text>
                    )}
                  </g>
                ))}
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
