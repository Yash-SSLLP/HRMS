/**
 * Schedule Task Reminders.
 *
 * NEW 2026-09-21 as one row per rule (Where: App / Email; When: before / after
 * the deadline, or repeat until done).
 *
 * ONE SHAPE ONLY SINCE 2026-09-29 (user, web and app alike: remove Email;
 * remove Before and After — "it should be by default Repeat Until Done,
 * without showing that"; "except Hourly remove other options"; from and until
 * 9 AM to 9 PM by default). A reminder is now: in the app, every N hours on the
 * clock inside a window, until the work is done. One such rule per task (the
 * server keeps the first), so "Add a reminder" goes once it is there.
 *
 * A rule from before the change (an email one, "1 day before") is kept as it
 * is and listed as a chip to be taken off — never dropped by a save.
 */
import { FiPlus, FiTrash2, FiX, FiBell } from 'react-icons/fi';
import { reminderLabel } from '../../utils/taskLifecycle';
import ReminderPattern, { repeatingRule } from './ReminderPattern';

export default function ReminderEditor({ value = [], onChange, onClose }) {
  const list = Array.isArray(value) ? value : [];
  const everyAt = list.findIndex((r) => r.when === 'EVERY');
  const replace = (i, rule) => onChange?.(list.map((r, j) => (j === i ? rule : r)));
  const remove = (i) => onChange?.(list.filter((_, j) => j !== i));
  const others = list.map((r, i) => [r, i]).filter(([r]) => r.when !== 'EVERY');

  return (
    <div className="space-y-3 rounded-xl border border-gray-200 bg-gray-50 p-3">
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-1.5 text-xs font-semibold text-gray-700">
          <FiBell size={12} /> Reminders
        </h3>
        {onClose && (
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-600" aria-label="Close">
            <FiX size={14} />
          </button>
        )}
      </div>

      {list.length === 0 && (
        <p className="text-xs text-gray-500">
          No reminders of your own — the company&apos;s usual one goes.
        </p>
      )}

      {everyAt >= 0 && (
        <div className="space-y-2 rounded-lg border border-gray-200 bg-white p-2.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] font-medium text-gray-500">Every few hours until it is done</span>
            <button
              type="button"
              onClick={() => remove(everyAt)}
              className="rounded-lg border border-red-200 px-2 text-xs text-red-600 hover:bg-red-50 min-h-[30px]"
              aria-label="Remove this reminder"
            >
              <FiTrash2 size={12} />
            </button>
          </div>
          <ReminderPattern value={list[everyAt]} allowOff={false} hourlyOnly onChange={(r) => r && replace(everyAt, r)} />
        </div>
      )}

      {/* Rules from before 2026-09-29 — kept, shown, removable. */}
      {others.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {others.map(([r, i]) => (
            <span
              key={`${r.when}-${r.amount}-${r.unit}-${r.channel}-${i}`}
              className="inline-flex items-center gap-1 rounded-lg border border-gray-200 bg-white py-1 pl-2.5 pr-1 text-xs text-gray-600"
            >
              {reminderLabel(r)} the deadline{r.channel === 'EMAIL' ? ' · email' : ''}
              <button
                type="button"
                onClick={() => remove(i)}
                className="grid place-items-center rounded-md p-1 text-gray-400 transition hover:bg-gray-100 hover:text-gray-700"
                aria-label={`Remove the reminder ${reminderLabel(r)}`}
              >
                <FiX size={12} />
              </button>
            </span>
          ))}
        </div>
      )}

      {everyAt < 0 && (
        <button
          type="button"
          onClick={() => onChange?.([...list, repeatingRule('HOURLY')])}
          className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 text-xs font-medium text-gray-600 hover:border-gray-400 hover:text-blue-600 min-h-[32px]"
        >
          <FiPlus size={12} /> Add a reminder
        </button>
      )}
    </div>
  );
}
