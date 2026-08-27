/**
 * The one empty state every approval queue uses.
 *
 * The five inboxes on the Approvals page each grew their own "nothing here"
 * line — one italic grey sentence inside a card, three bare `text-gray-500`
 * divs with no card at all — so a page with nothing waiting read as four
 * different kinds of nothing. This is the single shape: a soft tinted glyph
 * over one line of copy, centred in whatever container the section gives it.
 *
 * Deliberately NOT a card: the section shell around it already draws the card,
 * and nesting a second one produced a box-in-a-box on the tabbed queues.
 */
import { FiCheck } from 'react-icons/fi';

export default function ApprovalsEmpty({ message = 'Nothing is waiting on you right now.', hint }) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-10 px-4">
      <span className="flex items-center justify-center w-11 h-11 rounded-full bg-emerald-50 text-emerald-600 border border-emerald-200">
        <FiCheck size={20} strokeWidth={2.4} />
      </span>
      <p className="mt-3 text-sm font-semibold tracking-tight text-gray-800">{message}</p>
      {hint && <p className="mt-1.5 text-xs text-gray-500 leading-relaxed max-w-sm">{hint}</p>}
    </div>
  );
}
