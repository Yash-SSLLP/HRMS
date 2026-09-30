/**
 * When a request was made — "Requested 30 Sept 2026, 9:14 AM" — for the cards
 * of every approvals tab (2026-09-30, user: "for all these also show time of
 * request … for leave, worked on a leave day, etc. in all"). Its own line under
 * the person's name, in To approve and in History alike. Renders nothing when
 * the row carries no time.
 * @param {{at?: string|Date, label?: string, className?: string}} props
 */
import { FiClock } from 'react-icons/fi';
import { formatDateTime12 } from '../utils/time';

export default function RequestedAt({ at, label = 'Requested', className = '' }) {
  if (!at) return null;
  return (
    <div className={`flex items-center gap-1 text-[11px] text-gray-500 mt-0.5 ${className}`}>
      <FiClock size={11} className="shrink-0" />
      <span>{label} {formatDateTime12(at)}</span>
    </div>
  );
}
