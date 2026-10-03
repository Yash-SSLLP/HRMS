/**
 * AbsentAlert — the banner that says nobody has heard from these people yet.
 *
 * Shared by the manager team board and HR's org-wide presence board, because the
 * rule behind it is one rule: before the cut-off nobody is late, they simply
 * have not arrived, so the banner only appears once the day is today AND the
 * cut-off has passed AND somebody is still unaccounted for.
 *
 * `storageKey` is the namespace a dismissal is remembered under, and the two
 * boards MUST pass different ones — dismissing "my team hasn't shown up" should
 * not also silence "nobody in the company has".
 */
import { useEffect, useState } from 'react';
import { FiAlertTriangle } from 'react-icons/fi';
import { formatTime12 } from '../utils/time';

// Remembered per reader per day, so it does not reappear on every visit — but a
// browser with storage blocked must still render the page, hence every touch is
// wrapped.
const read = (key) => {
  try { return localStorage.getItem(key) === '1'; } catch { return false; }
};
const write = (key) => {
  try { localStorage.setItem(key, '1'); } catch { /* banner simply returns next visit */ }
};

/**
 * @param {object|null} board - the presence payload: { isToday, lateCutoff: { at, passed }, absent[] }
 * @param {string} date - 'YYYY-MM-DD' the board is showing; scopes the dismissal
 * @param {string} storageKey - localStorage namespace, one per board
 * @param {number} maxNames - names to spell out before "+N more"; an org-wide
 *   list runs far longer than a manager's team, so the caller sets this
 * @param {() => void} [onSeeWho] - jump to the Absent tab
 */
export default function AbsentAlert({ board, date, storageKey, maxNames = 4, onSeeWho }) {
  const key = `${storageKey}.${date}`;
  const [dismissed, setDismissed] = useState(() => read(key));

  // Moving the board to another day asks the question again for that day.
  useEffect(() => { setDismissed(read(key)); }, [key]);

  const isToday = board?.isToday !== false;
  const absent = board?.absent || [];
  const cutoff = board?.lateCutoff;
  if (!isToday || !cutoff?.passed || absent.length === 0 || dismissed) return null;

  const named = absent.slice(0, maxNames).map((p) => p.name).join(', ');
  const more = absent.length - maxNames;

  // Styling: `.pb-alert` in index.css (2026-10-03 redesign).
  return (
    <div className="pb-alert" role="status">
      <span className="pb-alert-icon" aria-hidden="true"><FiAlertTriangle size={18} /></span>
      <div className="min-w-0 flex-1">
        <div className="pb-alert-title">
          {absent.length === 1 ? '1 person has' : `${absent.length} people have`} not checked in
          {cutoff.at && <span className="pb-alert-cut">since the {formatTime12(cutoff.at)} cut-off</span>}
        </div>
        <div className="pb-alert-names">{named}{more > 0 ? ` +${more} more` : ''}</div>
      </div>
      <div className="pb-alert-actions">
        {onSeeWho && (
          <button type="button" onClick={onSeeWho} className="trn-btn">See who</button>
        )}
        <button type="button" onClick={() => { write(key); setDismissed(true); }}
          className="trn-btn pb-alert-dismiss">
          Dismiss for today
        </button>
      </div>
    </div>
  );
}
