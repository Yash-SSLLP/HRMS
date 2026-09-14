// Who decided a Sunday / comp-off double-pay claim — and every decision since.
//
// The claim's `doublePay` field only ever holds the LATEST decision, so a
// "Change" used to erase whoever decided before. Every approve, reject and
// change is now written to the audit trail, and GET .../rest-day-work returns it
// per claim: `decision` (the latest) and `history` (all of them, oldest first).
//
// The backend has already masked a SuperAdmin decider as "the Backend" for
// anyone who isn't one (byRole comes back null for it), so this renders exactly
// what it is given. Shared by Admin → Attendance and My Team.
import { formatDateTime12 } from '../utils/time';
import { roleLabel } from '../config/roles';

const actor = (e) => `${e.byName}${e.byRole ? ` (${roleLabel(e.byRole)})` : ''}`;

/** "Approved for 2× by Asha Rao (HR Manager)" / "Changed Approved → Rejected by the Backend". */
export function decisionText(e) {
  const what = e.from === 'Pending' || !e.from
    ? (e.to === 'Approved' ? 'Approved for 2×' : 'Rejected')
    : `Changed ${e.from} → ${e.to}`;
  return `${what} by ${actor(e)}`;
}

/** The latest decision as one muted line: "by Asha Rao (HR Manager) · 14 Sept, 9:55 AM". */
export function DecidedBy({ decision, className = '' }) {
  if (!decision) return null;
  const when = formatDateTime12(decision.at, { year: false });
  return (
    <span className={`text-[11px] leading-4 text-gray-500 ${className}`}
      title={`${decision.status} by ${actor(decision)}${decision.at ? ` on ${formatDateTime12(decision.at)}` : ''}`}>
      by {actor(decision)}{when ? ` · ${when}` : ''}
    </span>
  );
}

/** Every recorded decision, oldest first — the full trail for one claim. */
export function DecisionHistory({ history }) {
  if (!history?.length) return null;
  return (
    <ol className="space-y-1">
      {history.map((e, i) => (
        <li key={`${e.at}-${i}`} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
          <span aria-hidden className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${
            e.to === 'Approved' ? 'bg-green-500' : 'bg-gray-400'}`} />
          <span className="text-gray-800">{decisionText(e)}</span>
          <span className="text-gray-400 whitespace-nowrap">{formatDateTime12(e.at)}</span>
        </li>
      ))}
    </ol>
  );
}
