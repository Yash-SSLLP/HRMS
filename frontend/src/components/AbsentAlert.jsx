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

  return (
    <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 flex flex-wrap items-start gap-3">
      <span className="text-lg leading-none text-amber-600" aria-hidden="true">⚠</span>
      <div className="min-w-0 flex-1 text-sm text-amber-900">
        <div className="font-semibold">
          {absent.length === 1 ? '1 person has' : `${absent.length} people have`} not checked in
        </div>
        <div className="mt-0.5">
          {named}{more > 0 ? ` +${more} more` : ''}
          {cutoff.at && ` · nothing since the ${formatTime12(cutoff.at)} cut-off`}
        </div>
        <div className="mt-2 flex flex-wrap gap-2">
          {onSeeWho && (
            <button type="button" onClick={onSeeWho}
              className="px-3 py-1.5 text-sm font-medium border border-amber-400 rounded-lg bg-white text-amber-900 hover:bg-amber-100">
              See who
            </button>
          )}
          <button type="button" onClick={() => { write(key); setDismissed(true); }}
            className="px-3 py-1.5 text-sm font-medium border border-transparent rounded-lg text-amber-800 hover:bg-amber-100">
            Dismiss for today
          </button>
        </div>
      </div>
    </div>
  );
}
