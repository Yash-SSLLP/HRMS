// Lightweight dependency-free vertical bar chart, with hover tooltips, a
// lift-on-hover effect and a staggered entrance animation.
// props: data = [{ label, value, color?, emptyLabel?, note? }].
//
// `emptyLabel` replaces the bar with that word set vertically in the plot area
// (and drops the value on top). It is for a column whose zero is not a result
// but an explanation — a Sunday nobody worked is not "0 present", it is a day
// the company was closed, and drawing it as a 3px stub next to real bars reads
// as a catastrophic day rather than a rest day. `note` adds a caption under the
// axis label, for the opposite case: the day IS a rest day and was worked
// anyway, so the bar is real but needs saying why it is there.
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
  // A caption sits BELOW the axis label, inside a bottom-aligned column, so a
  // single captioned column would be that much taller than its neighbours and
  // `justify-end` would push its bar and its date up out of line with the rest
  // (measured: 25px adrift). The row is therefore reserved in EVERY column once
  // any datum carries one, and the box grows by it so the bars keep their size.
  const NOTE_H = 28; // two lines of text-[10px] at leading-tight — a column is
                     // only 3.5rem wide, so "Sunday working" wraps rather than
                     // truncating to "Sunday wo…".
  const hasNotes = data.some((d) => d.note);

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
        style={{ height: height + (hasNotes ? NOTE_H : 0) }}
      >
        {data.map((d, i) => {
          const barH = Math.max(3, Math.round(((d.value || 0) / max) * plotH));
          // A per-bar colour wins (semantic categories like Present/Absent);
          // otherwise take the next categorical slot in order.
          const color = d.color || seriesColor(i);
          // Only stand in for the bar when there is genuinely nothing to plot —
          // a labelled day that was worked keeps its bar and takes `note`.
          const standIn = d.emptyLabel && !(d.value > 0) ? d.emptyLabel : null;
          return (
            <div
              key={i}
              className="chart-col group relative flex flex-col items-center justify-end h-full w-14"
              style={{ animationDelay: `${i * 55}ms` }}
            >
              <span className="chart-tip">{d.label}: {standIn || d.value}</span>
              {standIn ? (
                // Rotated 180° on top of vertical-rl so it reads bottom-to-top,
                // the way an axis label is read, instead of top-down.
                <span
                  className="text-[11px] text-gray-400 tracking-wide whitespace-nowrap"
                  style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}
                >
                  {standIn}
                </span>
              ) : (
                <>
                  <span className="text-xs font-semibold text-gray-700 mb-1">{d.value}</span>
                  <div
                    className="chart-bar w-10"
                    style={{ height: barH, background: color }}
                  />
                </>
              )}
              <span className="mt-2 text-[11px] text-gray-500 text-center leading-tight w-full break-words">
                {d.label}
              </span>
              {/* shrink-0 matters: a column is a flex box that lets its BAR
                  absorb any overflow, and without it the two-line caption is
                  squeezed 1.4px while the blank ones are not, which drifts that
                  column's bar and date out of line with its neighbours. */}
              {hasNotes && (
                <span
                  className="shrink-0 text-[10px] text-amber-600 text-center leading-tight w-full break-words"
                  style={{ height: NOTE_H }}
                >
                  {d.note || ' '}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
