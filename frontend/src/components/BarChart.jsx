// Lightweight dependency-free vertical bar chart, with hover tooltips, a
// lift-on-hover effect and a staggered entrance animation.
// props: data = [{ label, value, color? }].
//
// Bars are filled with a SOLID colour. They used to carry a top-to-bottom
// gradient, which meant the same bar was two different colours depending on
// where you looked — the fill has to read as one value, so it is one colour.
import { seriesColor } from '../theme/chartColors';
import useScrollToLatest from '../hooks/useScrollToLatest';

export default function BarChart({ data = [], height = 200 }) {
  // Opens at the newest bar on a phone; a no-op once the plot fits.
  const scrollRef = useScrollToLatest(data);

  if (data.length === 0) {
    return <p className="text-sm text-gray-400 italic">No data to chart</p>;
  }

  const max = Math.max(1, ...data.map((d) => d.value || 0));
  const plotH = height - 32; // room for the value label above + axis label below

  return (
    <div ref={scrollRef} className="w-full overflow-x-auto">
      {/* Centring here is `min-w-full` + `safe center`, NOT `mx-auto`.
          `mx-auto` on an overflowing child splits the overflow across BOTH
          sides, which strands the first bars off-screen with no way to scroll
          back to them — that is what opened the chart mid-plot. And
          `justify-content` alone does nothing on a bare `w-max` box, because a
          max-content box has no free space to distribute: `min-w-full` is what
          gives it room to centre in when the bars fit. When they do not fit,
          `w-max` wins over `min-w-full` and `safe` degrades to start
          alignment, keeping the left end reachable. */}
      <div
        className="flex items-end gap-5 w-max min-w-full px-2 [justify-content:safe_center]"
        style={{ height }}
      >
        {data.map((d, i) => {
          const barH = Math.max(3, Math.round(((d.value || 0) / max) * plotH));
          // A per-bar colour wins (semantic categories like Present/Absent);
          // otherwise take the next categorical slot in order.
          const color = d.color || seriesColor(i);
          return (
            <div
              key={i}
              className="chart-col group relative flex flex-col items-center justify-end h-full w-14"
              style={{ animationDelay: `${i * 55}ms` }}
            >
              <span className="chart-tip">{d.label}: {d.value}</span>
              <span className="text-xs font-semibold text-gray-700 mb-1">{d.value}</span>
              <div
                className="chart-bar w-10"
                style={{ height: barH, background: color }}
              />
              <span className="mt-2 text-[11px] text-gray-500 text-center leading-tight w-full break-words">
                {d.label}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
