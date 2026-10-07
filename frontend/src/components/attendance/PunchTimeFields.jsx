/**
 * The check-in / check-out boxes of an attendance form — clock times on the
 * form's Date (see utils/attendancePunch). Shared by the edit forms on Admin →
 * Attendance and the Monthly View, and by the Super Admin's Mark attendance.
 *
 * `removable`: a bin beside a filled box empties it (the punch is cleared on
 * Save); once emptied, an undo arrow puts the stored time back. Off for the
 * mark form, which only ever adds times — clearing one is the edit's job.
 */
import { FiTrash2, FiRotateCcw } from 'react-icons/fi';
import { formatTime12 } from '../../utils/time';

const PUNCHES = [['checkIn', 'Check-in'], ['checkOut', 'Check-out']];

export default function PunchTimeFields({ form, setForm, removable = true, idPrefix = 'att' }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-gray-50/60 p-3">
      <p className="text-sm font-medium text-gray-800 mb-2">Punch times</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {PUNCHES.map(([k, label]) => {
          const stored = form.orig?.[k] || '';
          const removed = removable && !!stored && !form[k];
          return (
            <div key={k}>
              <label htmlFor={`${idPrefix}-${k}`} className="block text-xs font-medium text-gray-600 mb-1">{label}</label>
              <div className="flex items-center gap-1.5">
                <input id={`${idPrefix}-${k}`} type="time" value={form[k] || ''}
                  onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))}
                  className={`block w-full min-w-0 border rounded-lg px-3 py-2 ${removed ? 'border-red-300 bg-red-50' : ''}`} />
                {removable && form[k] ? (
                  <button type="button" onClick={() => setForm((f) => ({ ...f, [k]: '' }))}
                    title={`Remove ${label.toLowerCase()}`} aria-label={`Remove ${label.toLowerCase()}`}
                    className="shrink-0 inline-flex items-center justify-center w-10 h-10 rounded-lg border text-red-600 hover:bg-red-50">
                    <FiTrash2 />
                  </button>
                ) : removed ? (
                  <button type="button" onClick={() => setForm((f) => ({ ...f, [k]: stored }))}
                    title={`Restore ${formatTime12(stored)}`} aria-label={`Restore ${label.toLowerCase()}`}
                    className="shrink-0 inline-flex items-center justify-center w-10 h-10 rounded-lg border text-gray-700 hover:bg-gray-100">
                    <FiRotateCcw />
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
