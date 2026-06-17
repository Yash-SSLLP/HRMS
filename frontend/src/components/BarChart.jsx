// Lightweight dependency-free vertical bar chart.
// props: data = [{ label, value }]. Bars use the role accent colour (var(--accent)).
export default function BarChart({ data = [], height = 200 }) {
  if (data.length === 0) {
    return <p className="text-sm text-gray-400 italic">No data to chart</p>;
  }

  const max = Math.max(1, ...data.map((d) => d.value || 0));
  const plotH = height - 28; // leave room for labels under the bars

  return (
    <div className="overflow-x-auto">
      <div
        className="flex items-end gap-3"
        style={{ height, minWidth: Math.max(data.length * 56, 200) }}
      >
        {data.map((d, i) => {
          const barH = Math.max(2, Math.round(((d.value || 0) / max) * plotH));
          return (
            <div key={i} className="flex-1 min-w-[40px] flex flex-col items-center justify-end h-full">
              <span className="text-xs font-medium text-gray-700 mb-1">{d.value}</span>
              <div
                className="w-full max-w-[44px] rounded-t accent-bg transition-all"
                style={{ height: barH }}
                title={`${d.label}: ${d.value}`}
              />
              <span className="mt-1.5 text-[11px] text-gray-500 text-center leading-tight w-full truncate" title={d.label}>
                {d.label}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
