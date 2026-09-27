/**
 * − value + : a number chosen in steps, worded in the middle ("every 3 days",
 * "15th", "every 2 hours"). Shared by the recurring form's Repeats builder and
 * the reminder builder beside it (ReminderPattern), so the two read as one.
 *
 * No `h-` class on the buttons: they take the 40px touch floor on a phone (see
 * the responsive touch layer in index.css) and stay compact on a desk.
 */
import { FiMinus, FiPlus } from 'react-icons/fi';

export default function Stepper({ value, min, max, onChange, format, label }) {
  const set = (n) => onChange(Math.min(max, Math.max(min, n)));
  return (
    <span className="inline-flex items-center gap-1 rounded-xl border border-gray-200 bg-white p-0.5" role="group" aria-label={label}>
      <button
        type="button"
        onClick={() => set(value - 1)}
        disabled={value <= min}
        className="grid min-w-[32px] place-items-center rounded-lg px-2 py-2 text-gray-500 transition hover:bg-gray-100 disabled:opacity-30"
        aria-label="Less"
      >
        <FiMinus size={13} />
      </button>
      <span className="min-w-[5.5rem] text-center text-xs font-semibold tabular-nums text-gray-800">{format ? format(value) : value}</span>
      <button
        type="button"
        onClick={() => set(value + 1)}
        disabled={value >= max}
        className="grid min-w-[32px] place-items-center rounded-lg px-2 py-2 text-gray-500 transition hover:bg-gray-100 disabled:opacity-30"
        aria-label="More"
      >
        <FiPlus size={13} />
      </button>
    </span>
  );
}
