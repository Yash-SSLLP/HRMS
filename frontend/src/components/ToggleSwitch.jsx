/**
 * ToggleSwitch — the standard on/off control for a permission or a setting.
 *
 * WHY A SWITCH AND NOT A BUTTON. The Permissions page used to paint every grant
 * as a filled pill in its own colour — teal for cashbook, purple for export,
 * indigo for WFH, sky for punch-anywhere, amber for executives. Five hues on one
 * row carries no meaning (nothing about "export" is more purple than "assets"),
 * and a screen of saturated pills reads as a toy rather than an access-control
 * console. A switch says the one thing that matters at a glance — on or off —
 * and says it identically in every column, so the eye can scan a row and a
 * column without decoding a palette.
 *
 * The ON state uses the portal accent (`accent-bg`, never a hardcoded hex), so
 * it follows the role/portal palette and both themes for free.
 *
 * ACCESSIBILITY. A real `role="switch"` with `aria-checked`, so a screen reader
 * announces the state rather than "button". The visible label stays outside the
 * control (the table's column header does that job here), and `title` carries
 * the explanation for a pointer user.
 */
import { FiLoader } from 'react-icons/fi';

/**
 * @param {object} props
 * @param {boolean} props.checked
 * @param {() => void} props.onChange   Fired on click/Enter/Space.
 * @param {boolean} [props.disabled]
 * @param {boolean} [props.busy]        Show a spinner and block input while saving.
 * @param {string} props.label          Accessible name — what this grants.
 * @param {string} [props.title]        Longer explanation, shown on hover.
 * @param {'sm'|'md'} [props.size]
 */
export default function ToggleSwitch({
  checked, onChange, disabled = false, busy = false, label, title, size = 'md',
}) {
  const sm = size === 'sm';
  const track = sm ? 'h-[18px] w-[32px]' : 'h-[22px] w-[38px]';
  const knob = sm ? 'h-3.5 w-3.5' : 'h-[18px] w-[18px]';
  const travel = sm ? 'translate-x-[14px]' : 'translate-x-4';

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={title || label}
      disabled={disabled || busy}
      onClick={onChange}
      className={`relative inline-flex shrink-0 items-center rounded-full border transition-colors
        focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-[var(--accent)]
        disabled:opacity-45 disabled:cursor-not-allowed ${track}
        ${checked
        ? 'accent-bg border-transparent'
        : 'bg-gray-200 border-gray-300 hover:bg-gray-300'}`}
    >
      {/* The knob. `transform` rather than a left offset so the movement is
          composited — a permissions table can hold a hundred of these. */}
      <span
        aria-hidden="true"
        className={`pointer-events-none inline-flex items-center justify-center rounded-full bg-white shadow
          transition-transform duration-150 ease-out ${knob}
          ${checked ? travel : 'translate-x-[2px]'}`}
      >
        {busy && <FiLoader size={sm ? 9 : 11} className="animate-spin text-gray-500" />}
      </span>
    </button>
  );
}
