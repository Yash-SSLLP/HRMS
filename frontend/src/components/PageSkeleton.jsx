// Loading placeholder shown (via Suspense) while a page's code/data loads.
// Mirrors the common layout: a header row, stat cards, then a list/table block.
function Bar({ className = '' }) {
  return <div className={`skeleton rounded ${className}`} />;
}

export default function PageSkeleton() {
  return (
    <div>
      {/* page header */}
      <div className="flex items-center justify-between gap-3 mb-6">
        <div className="space-y-2">
          <Bar className="h-6 w-48" />
          <Bar className="h-3 w-64" />
        </div>
        <Bar className="h-9 w-28" />
      </div>

      {/* stat cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="bg-white shadow rounded-lg p-5 flex items-center gap-4">
            <Bar className="h-12 w-12 rounded-xl" />
            <div className="flex-1 space-y-2">
              <Bar className="h-5 w-14" />
              <Bar className="h-3 w-20" />
            </div>
          </div>
        ))}
      </div>

      {/* content block */}
      <div className="bg-white shadow rounded-lg p-5 space-y-4">
        <Bar className="h-4 w-40" />
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3">
            <Bar className="h-10 w-10 rounded-full" />
            <div className="flex-1 space-y-2">
              <Bar className="h-3 w-1/3" />
              <Bar className="h-3 w-1/2" />
            </div>
            <Bar className="h-3 w-16" />
          </div>
        ))}
      </div>
    </div>
  );
}
