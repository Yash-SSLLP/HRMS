import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { FiAlertTriangle } from 'react-icons/fi';
import api from '../api/client';
import { useAuthStore } from '../store/authStore';

// Complaints are confidential to the CEO, HR and SuperAdmins (never the accused).
const VIEWER_ROLES = ['SuperAdmin', 'HRManager', 'CEO'];
const nameOf = (u) => (u ? `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.email : 'Someone');
const when = (d) => new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

// A high-priority banner on the admin dashboard surfacing OPEN complaints to the
// leadership group — more prominent (red) than announcements, because they're
// sensitive and time-critical. Hidden for anyone else, and never shows a
// complaint raised against the current viewer (the API already excludes those).
export default function ComplaintsBanner() {
  const role = useAuthStore((s) => s.user?.role);
  const [items, setItems] = useState([]);

  useEffect(() => {
    if (!VIEWER_ROLES.includes(role)) return;
    api.get('/complaints/assigned')
      .then(({ data }) => setItems((data.complaints || []).filter((c) => c.status === 'open' || c.status === 'under_review')))
      .catch(() => {});
  }, [role]);

  if (!VIEWER_ROLES.includes(role) || items.length === 0) return null;

  const top = items.slice(0, 4);
  return (
    <div className="mb-4 bg-red-50 border border-red-200 rounded-xl p-4 shadow-sm">
      <div className="flex items-center gap-2 flex-wrap mb-2.5">
        <FiAlertTriangle className="text-red-600 shrink-0" size={18} />
        <span className="font-semibold text-red-800">
          {items.length} complaint{items.length === 1 ? '' : 's'} need{items.length === 1 ? 's' : ''} your attention
        </span>
        <span className="text-[10px] font-semibold uppercase tracking-wide bg-red-600 text-white rounded-full px-2 py-0.5">Important · Confidential</span>
      </div>
      <div className="space-y-1.5">
        {top.map((c) => (
          <Link key={c._id} to="/admin/complaints"
            className="block bg-white/70 hover:bg-white rounded-lg px-3 py-2 border border-red-100">
            <div className="text-sm font-medium text-gray-900 truncate">{c.subject}</div>
            <div className="text-xs text-gray-500">
              By {nameOf(c.complainant)} · against {nameOf(c.against)} · {when(c.createdAt)}
              {c.status === 'under_review' ? ' · Under review' : ''}
            </div>
          </Link>
        ))}
      </div>
      <div className="text-right mt-2">
        <Link to="/admin/complaints" className="text-xs text-red-700 font-medium hover:underline">Open Complaints inbox →</Link>
      </div>
    </div>
  );
}
