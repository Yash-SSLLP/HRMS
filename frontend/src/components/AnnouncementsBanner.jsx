import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { FiX, FiVolume2 } from 'react-icons/fi';
import api from '../api/client';

// Category → accent colour for the banner's left border + chip.
const CAT_STYLE = {
  Urgent:   { bar: '#ef4444', chip: 'bg-red-100 text-red-800' },
  Policy:   { bar: '#6366f1', chip: 'bg-indigo-100 text-indigo-800' },
  Event:    { bar: '#f59e0b', chip: 'bg-amber-100 text-amber-800' },
  Holiday:  { bar: '#22c55e', chip: 'bg-green-100 text-green-800' },
  Benefits: { bar: '#14b8a6', chip: 'bg-teal-100 text-teal-800' },
  General:  { bar: '#94a3b8', chip: 'bg-gray-100 text-gray-700' },
};

const when = (d) => new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

// Shows every announcement the employee hasn't dismissed, on the overview page.
// Closing one calls the per-user dismiss endpoint so it stays hidden (it remains
// visible in the full Announcements feed).
export default function AnnouncementsBanner() {
  const [items, setItems] = useState([]);
  const [busyId, setBusyId] = useState(null);
  const [openItem, setOpenItem] = useState(null); // announcement shown in full in a modal

  useEffect(() => {
    api.get('/announcements')
      .then(({ data }) => setItems((data.announcements || []).filter((a) => !a.dismissed)))
      .catch(() => {});
  }, []);

  const dismiss = async (id) => {
    setBusyId(id);
    // Optimistically remove; revert on failure.
    const prev = items;
    setItems((list) => list.filter((a) => a._id !== id));
    try {
      await api.post(`/announcements/${id}/dismiss`);
    } catch {
      setItems(prev);
    } finally {
      setBusyId(null);
    }
  };

  if (items.length === 0) return null;

  return (
    <div className="mb-4 space-y-2">
      {items.map((a) => {
        const s = CAT_STYLE[a.category] || CAT_STYLE.General;
        return (
          <div
            key={a._id}
            className="relative bg-white shadow rounded-lg p-4 pr-10 border-l-4"
            style={{ borderLeftColor: s.bar }}
          >
            <button
              type="button"
              onClick={() => dismiss(a._id)}
              disabled={busyId === a._id}
              aria-label="Dismiss announcement"
              title="Dismiss"
              className="absolute top-2.5 right-2.5 text-gray-400 hover:text-gray-700 disabled:opacity-50"
            >
              <FiX size={18} />
            </button>
            <div className="flex items-center gap-2 flex-wrap mb-1">
              <FiVolume2 className="text-gray-400 shrink-0" size={15} />
              <span className="font-semibold text-gray-900">{a.title}</span>
              {a.pinned && <span className="text-[10px] font-semibold uppercase tracking-wide text-amber-700 bg-amber-100 rounded-full px-2 py-0.5">Pinned</span>}
              <span className={`text-[10px] font-medium rounded-full px-2 py-0.5 ${s.chip}`}>{a.category || 'General'}</span>
            </div>
            <p className={`text-sm text-gray-700 whitespace-pre-wrap break-words ${(a.body || '').length > 220 ? 'line-clamp-3' : ''}`}>{a.body}</p>
            {(a.body || '').length > 220 && (
              <button type="button" onClick={() => setOpenItem(a)} className="text-xs text-blue-600 hover:underline mt-1">Read more</button>
            )}
            <div className="text-[11px] text-gray-400 mt-1.5">
              {a.createdBy ? `${a.createdBy.firstName} ${a.createdBy.lastName} · ` : ''}{when(a.createdAt)}
            </div>
          </div>
        );
      })}
      <div className="text-right">
        <Link to="/employee/announcements" className="text-xs text-blue-600 hover:underline">All announcements →</Link>
      </div>

      {openItem && (() => {
        const s = CAT_STYLE[openItem.category] || CAT_STYLE.General;
        return (
          <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50 overflow-y-auto py-8" onMouseDown={() => setOpenItem(null)}>
            <div className="bg-white rounded-xl shadow-lg w-full max-w-lg p-6" onMouseDown={(e) => e.stopPropagation()}>
              <div className="flex items-start justify-between gap-3 mb-2">
                <h2 className="card-title break-words">{openItem.title}</h2>
                <button type="button" onClick={() => setOpenItem(null)} className="shrink-0 text-gray-400 hover:text-gray-700 text-xl leading-none">×</button>
              </div>
              <div className="flex items-center gap-2 flex-wrap mb-3">
                {openItem.pinned && <span className="text-[10px] font-semibold uppercase tracking-wide text-amber-700 bg-amber-100 rounded-full px-2 py-0.5">Pinned</span>}
                <span className={`text-[10px] font-medium rounded-full px-2 py-0.5 ${s.chip}`}>{openItem.category || 'General'}</span>
                <span className="text-[11px] text-gray-400">
                  {openItem.createdBy ? `${openItem.createdBy.firstName} ${openItem.createdBy.lastName} · ` : ''}{when(openItem.createdAt)}
                </span>
              </div>
              <p className="text-sm text-gray-700 whitespace-pre-wrap break-words max-h-[60vh] overflow-y-auto">{openItem.body}</p>
              <div className="flex justify-end pt-4">
                <button type="button" onClick={() => setOpenItem(null)} className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">Close</button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
