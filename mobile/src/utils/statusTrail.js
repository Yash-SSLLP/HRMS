/**
 * Reading the `statusHistory` the API attaches to a record (built from AuditLog
 * by the auditStatus schema plugin) — the mobile counterpart of the web
 * components/StatusTrail.jsx. Keep the fallback rules in step.
 */

const fullName = (u) => `${u?.firstName || ''} ${u?.lastName || ''}`.trim();

/**
 * "by <name> (<role>)" for one trail entry.
 *
 * Rows written before uploads stopped losing the request context carry no
 * actor. On a submission that is harmless — it can only have been the person
 * whose list this is — so it degrades to "by you" rather than a blank.
 * @param {{from: ?string, byName: ?string, byRole: ?string}} entry
 * @returns {string}
 */
export function actorOf(entry) {
  if (entry?.byName) return `by ${entry.byName}${entry.byRole ? ` (${entry.byRole})` : ''}`;
  return entry?.from ? 'by a reviewer' : 'by you';
}

/**
 * The most recent status change, normalised across the two sources.
 *
 * The audit row is written fire-and-forget after the save, so a list fetched
 * straight after an action can arrive before its newest trail entry exists.
 * Whenever the trail's tail doesn't match the record's current status we fall
 * back to the record's own reviewedBy/reviewedAt — which also covers claims
 * older than the audit log itself.
 *
 * @param {{status?: string, statusHistory?: Array, reviewedBy?: Object, reviewedAt?: string}} record
 * @returns {{to: string, byName: string, at: string}|null} null while nobody
 *   has acted on the record yet.
 */
export function lastChange(record) {
  const trail = record?.statusHistory || [];
  const last = [...trail].reverse().find((h) => h.from); // skip the submission row
  if (last && last.to === record?.status) {
    return { to: last.to, byName: last.byName || '', at: last.at };
  }
  if (record?.reviewedBy || record?.reviewedAt) {
    return { to: record.status, byName: fullName(record.reviewedBy), at: record.reviewedAt };
  }
  return last ? { to: last.to, byName: last.byName || '', at: last.at } : null;
}
