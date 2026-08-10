/**
 * StatusTrail — "who moved this, and when".
 *
 * Reads the `statusHistory` the API attaches to a record (from AuditLog, via
 * the auditStatus schema plugin). Two pieces:
 *   <StatusTrailLine/>  one line under a status badge naming the last actor
 *   <StatusTrailModal/> the full trail, for records that changed hands more
 *                       than once (approved by one person, paid by another)
 *
 * The audit row is written fire-and-forget after the save, so a list fetched
 * immediately after an action can arrive before its newest trail entry exists.
 * `lastChange()` therefore falls back to the record's own reviewedBy/reviewedAt
 * whenever the trail's tail doesn't match the current status — which also
 * covers claims older than the audit log itself.
 */
import { FiClock, FiX } from 'react-icons/fi';
import { formatDateTime12 } from '../utils/time';

const fullName = (u) => `${u?.firstName || ''} ${u?.lastName || ''}`.trim();

/**
 * "by <name> (<role>)" for one trail entry.
 *
 * Rows written before uploads stopped losing the request context carry no
 * actor. For a submission that is harmless — it can only have been the person
 * the record belongs to — so it degrades to a description rather than a blank.
 * @param {{from: ?string, byName: ?string, byRole: ?string}} entry
 * @returns {string}
 */
const actorOf = (entry) => {
  if (entry.byName) return `by ${entry.byName}${entry.byRole ? ` (${entry.byRole})` : ''}`;
  return entry.from ? 'by a reviewer' : 'by the claimant';
};

/**
 * The most recent status change, normalised across the two sources.
 * @param {{status?: string, statusHistory?: Array, reviewedBy?: Object, reviewedAt?: string}} record
 * @returns {{to: string, byName: string, at: string}|null} null while the
 *   record is still in its submitted state (nobody has acted on it yet).
 */
export function lastChange(record) {
  const trail = record?.statusHistory || [];
  const last = [...trail].reverse().find((h) => h.from); // skip the submission row
  if (last && last.to === record?.status) {
    return { to: last.to, byName: last.byName || '', at: last.at };
  }
  // Trail missing, stale, or pre-dating the audit log — use the record's own fields.
  if (record?.reviewedBy || record?.reviewedAt) {
    return { to: record.status, byName: fullName(record.reviewedBy), at: record.reviewedAt };
  }
  return last ? { to: last.to, byName: last.byName || '', at: last.at } : null;
}

/**
 * One line naming who last changed the status, e.g. "Reimbursed by Ankit Roy ·
 * 10 Aug, 12:15 PM". Renders nothing while a record is still untouched.
 */
export function StatusTrailLine({ record, className = '' }) {
  const last = lastChange(record);
  if (!last) return null;
  return (
    <div className={`text-xs text-gray-500 ${className}`}>
      {last.to} by <span className="font-medium text-gray-600">{last.byName || 'a reviewer'}</span>
      {last.at ? ` · ${formatDateTime12(last.at, { year: false })}` : ''}
    </div>
  );
}

/**
 * A "History" button that appears only once a record has actually changed hands
 * — a Pending claim nobody has touched has nothing worth opening.
 */
export function StatusTrailButton({ record, onClick, className = '' }) {
  const steps = (record?.statusHistory || []).filter((h) => h.from);
  if (steps.length < 1) return null;
  return (
    <button type="button" onClick={onClick}
      className={`inline-flex items-center gap-1 text-xs text-gray-500 hover:underline ${className}`}>
      <FiClock size={12} /> History
    </button>
  );
}

/** The full trail, oldest first, as a simple timeline. */
export function StatusTrailModal({ record, title = 'Status history', onClose }) {
  const trail = record?.statusHistory || [];
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-[60]" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-lg w-full max-w-md p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <h2 className="card-title">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="topbar-icon-btn">
            <FiX size={18} />
          </button>
        </div>

        {trail.length === 0 ? (
          <p className="text-sm text-gray-500">No status changes have been recorded yet.</p>
        ) : (
          <ol className="space-y-3">
            {trail.map((h, i) => (
              <li key={`${h.at}-${i}`} className="flex gap-3">
                <span className="mt-1.5 w-2 h-2 rounded-full accent-bg shrink-0" />
                <div className="min-w-0">
                  <div className="text-sm text-gray-900">
                    {h.from ? <>{h.from} → <span className="font-semibold">{h.to}</span></> : <span className="font-semibold">Submitted</span>}
                  </div>
                  <div className="text-xs text-gray-500">
                    {actorOf(h)}
                    {h.at ? ` · ${formatDateTime12(h.at)}` : ''}
                  </div>
                </div>
              </li>
            ))}
          </ol>
        )}

        <div className="flex justify-end pt-4">
          <button type="button" onClick={onClose}
            className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">Close</button>
        </div>
      </div>
    </div>
  );
}
