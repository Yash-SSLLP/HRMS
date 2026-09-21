/**
 * Schedule Task Reminders.
 *
 * NEW 2026-09-21. One row per rule, each saying WHERE and WHEN:
 *
 *   [App & portal] [Email]        1  [days ▾]  (•) Before  ( ) After
 *
 * The brief's version offers WhatsApp as a third channel. This portal has no
 * WhatsApp Business sender, and offering a channel that silently drops every
 * message is worse than not offering it — so the two that exist are the two
 * shown, and config/tasks.REMINDER_CHANNELS is where a third would be added.
 *
 * AFTER-THE-DEADLINE REMINDERS ARE THE POINT of having a direction at all. "The
 * reminder will not stop — it will go automatically": a rule set to fire after
 * the due date also reaches whoever SET the task and whoever is in the loop,
 * because by then it is news the assigner needs rather than a nudge the doer
 * has already ignored (see services/taskReminderWorker).
 */
import { FiPlus, FiTrash2, FiX, FiBell } from 'react-icons/fi';
import { REMINDER_CHANNELS, REMINDER_UNITS, UNIT_LABELS, reminderLabel } from '../../utils/taskLifecycle';

const BLANK = { channel: 'APP', amount: 1, unit: 'DAYS', when: 'BEFORE' };

/** Is this rule already in the list? Two identical rules fire once. */
const same = (a, b) => a.channel === b.channel && Number(a.amount) === Number(b.amount)
  && a.unit === b.unit && a.when === b.when;

export default function ReminderEditor({ value = [], onChange, onClose }) {
  const set = (i, patch) => {
    const next = value.map((r, j) => (j === i ? { ...r, ...patch } : r));
    onChange?.(next);
  };

  const add = () => {
    // Offer something DIFFERENT from what is already there, or the + button
    // appears to do nothing (the duplicate is dropped on save anyway).
    const candidates = [
      BLANK,
      { ...BLANK, amount: 4, unit: 'HOURS' },
      { ...BLANK, amount: 30, unit: 'MINUTES' },
      { ...BLANK, when: 'AFTER' },
      { ...BLANK, channel: 'EMAIL' },
    ];
    const fresh = candidates.find((c) => !value.some((r) => same(r, c))) || BLANK;
    onChange?.([...value, fresh]);
  };

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

      {value.length === 0 && (
        <p className="text-xs text-gray-500">
          No reminders. Nobody will be chased about this one.
        </p>
      )}

      {value.map((rule, i) => (
        <div key={i} className="space-y-2 rounded-lg border border-gray-200 bg-white p-2.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] text-gray-500">Where</span>
            {REMINDER_CHANNELS.map((c) => (
              <button
                key={c.key}
                type="button"
                onClick={() => set(i, { channel: c.key })}
                className={`min-h-[30px] rounded-lg border px-2 text-xs font-medium transition ${
                  rule.channel === c.key
                    ? 'border-green-600 bg-green-600 text-white'
                    : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300'
                }`}
              >
                {c.label}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] text-gray-500">When</span>
            <input
              type="number"
              min={1}
              max={365}
              value={rule.amount}
              onChange={(e) => set(i, { amount: Number(e.target.value) })}
              className="w-16 rounded-lg border border-gray-200 px-2 text-xs min-h-[30px]"
              aria-label="How many"
            />
            <select
              value={rule.unit}
              onChange={(e) => set(i, { unit: e.target.value })}
              className="rounded-lg border border-gray-200 px-1 text-xs min-h-[30px]"
              aria-label="Units"
            >
              {REMINDER_UNITS.map((u) => (
                <option key={u} value={u}>{UNIT_LABELS[u]}</option>
              ))}
            </select>

            {['BEFORE', 'AFTER'].map((w) => (
              <button
                key={w}
                type="button"
                onClick={() => set(i, { when: w })}
                className={`min-h-[30px] rounded-lg border px-2 text-xs font-medium transition ${
                  rule.when === w
                    ? 'border-green-600 bg-green-600 text-white'
                    : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300'
                }`}
              >
                {w === 'BEFORE' ? 'Before' : 'After'}
              </button>
            ))}

            <button
              type="button"
              onClick={() => onChange?.(value.filter((_, j) => j !== i))}
              className="ml-auto rounded-lg border border-red-200 px-2 text-xs text-red-600 hover:bg-red-50 min-h-[30px]"
            >
              <FiTrash2 size={12} />
            </button>
          </div>

          <p className="text-[11px] text-gray-400">
            {reminderLabel(rule)} the deadline
            {rule.when === 'AFTER' && ' — also goes to whoever set the task'}
          </p>
        </div>
      ))}

      <button
        type="button"
        onClick={add}
        className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 text-xs font-medium text-gray-600 hover:border-gray-400 hover:text-blue-600 min-h-[32px]"
      >
        <FiPlus size={12} /> Add a reminder
      </button>
    </div>
  );
}
