import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { FiUsers, FiVideo } from 'react-icons/fi';
import api from '../api/client';

// When the employee has been assigned to take interviews, surface the upcoming
// ones on the dashboard — right alongside announcements and surveys — so they
// aren't missed. Data comes from the same endpoint the "My Interviews" page uses.
const fmtWhen = (iso) => {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-IN', {
    weekday: 'short', day: '2-digit', month: 'short',
    hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata',
  });
};

export default function InterviewsBanner() {
  const [items, setItems] = useState([]);

  useEffect(() => {
    api.get('/recruitment/my-interviews')
      .then(({ data }) => {
        const startToday = new Date();
        startToday.setHours(0, 0, 0, 0);
        const upcoming = (data.interviews || data.items || [])
          .filter((iv) => ['Pending', 'Scheduled'].includes(iv.status) && iv.scheduledAt
            && new Date(iv.scheduledAt) >= startToday)
          .sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt));
        setItems(upcoming);
      })
      .catch(() => {});
  }, []);

  if (items.length === 0) return null;

  return (
    <div className="mb-4 space-y-2">
      {items.map((iv) => (
        <div key={`${iv.candidateId}-${iv.index}`} className="bg-white shadow rounded-lg p-4 border-l-4" style={{ borderLeftColor: '#f59e0b' }}>
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <FiUsers className="text-amber-500 shrink-0" size={15} />
            <span className="font-semibold text-gray-900">Interview: {iv.candidateName}</span>
            <span className="text-[10px] font-medium rounded-full px-2 py-0.5 bg-amber-100 text-amber-800">{iv.label}</span>
            {iv.status === 'Scheduled' && (
              <span className="text-[10px] font-medium rounded-full px-2 py-0.5 bg-green-100 text-green-800">Scheduled</span>
            )}
          </div>
          <div className="text-sm text-gray-700">
            {iv.jobTitle ? <span className="text-gray-500">{iv.jobTitle} · </span> : null}
            {fmtWhen(iv.scheduledAt)}
            {iv.durationMinutes ? <span className="text-gray-500"> · {iv.durationMinutes < 60 ? `${iv.durationMinutes} min` : `${iv.durationMinutes / 60} hr`}</span> : null}
          </div>
          <div className="flex items-center justify-between gap-3 mt-2">
            <Link to="/employee/interviews" className="text-xs text-blue-600 hover:underline">View in My Interviews →</Link>
            {iv.meetingLink && (
              <a href={iv.meetingLink} target="_blank" rel="noreferrer"
                className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700">
                <FiVideo size={14} /> Join meeting
              </a>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
