/**
 * The one short question a status move asks — a remark, and a button.
 *
 * NEW 2026-09-25, for the status dropdown (TaskStatusMenu). Picking Approve,
 * Reject, In Review or Completed from a row lands here rather than on the full
 * task page: the user asked for a simpler page, and a move that needs one line
 * of text should cost one line of text.
 *
 * WHEN THE REMARK IS REQUIRED. Only where somebody else cannot act without it:
 * turning a task down (whoever set it has to reassign it) and sending a
 * submission back (the doer has to know what is missing). The server insists
 * on those two as well. Everywhere else the box is optional, and an empty one
 * sends a plain default ("Approved.") — the engine still refuses a SILENT move
 * (services/taskEngine.move), so the feed always says what happened, but
 * nobody is made to type "ok" to approve good work.
 */
import { useEffect, useRef, useState } from 'react';
import { FiX, FiCheckCircle, FiRotateCcw, FiThumbsDown, FiSend, FiCheck } from 'react-icons/fi';

/**
 * What each move says. `defaultNote` is sent when the box is left empty; a
 * move without one requires a remark.
 */
const COPY = {
  approve: {
    title: 'Approve this task?',
    body: 'It is marked completed and the points are recorded.',
    label: 'Remark',
    placeholder: 'Anything to say about the work? (optional)',
    defaultNote: 'Approved.',
    confirm: 'Approve',
    icon: FiCheckCircle,
    tone: 'green',
  },
  sendBack: {
    title: 'Send it back?',
    body: 'It reopens with everything already done still on it.',
    label: 'What still needs doing?',
    placeholder: 'e.g. The March figures are missing',
    confirm: 'Send back',
    icon: FiRotateCcw,
    tone: 'red',
  },
  decline: {
    title: 'Reject this task?',
    body: 'Whoever set it is told, with your reason, so it can go to somebody else.',
    label: 'Why can you not take it on?',
    placeholder: 'e.g. I am on leave from Thursday',
    confirm: 'Reject',
    icon: FiThumbsDown,
    tone: 'red',
  },
  submit: {
    title: 'Send for review?',
    body: 'It goes to whoever set it, who approves it or sends it back.',
    label: 'What did you do?',
    placeholder: 'A line about the work (optional)',
    defaultNote: 'Submitted for review.',
    confirm: 'Send for review',
    icon: FiSend,
    tone: 'violet',
  },
  complete: {
    title: 'Mark as completed?',
    body: 'It is finished for everybody on it.',
    label: 'Remark',
    placeholder: 'Anything to add? (optional)',
    defaultNote: 'Marked completed.',
    confirm: 'Mark completed',
    icon: FiCheck,
    tone: 'green',
  },
};

const TONES = {
  green: { chip: 'bg-green-50 text-green-700', button: 'bg-green-600 hover:bg-green-700' },
  red: { chip: 'bg-red-50 text-red-600', button: 'bg-red-600 hover:bg-red-700' },
  violet: { chip: 'bg-violet-50 text-violet-700', button: 'bg-violet-600 hover:bg-violet-700' },
};

export default function TaskActionDialog({ action, task, onClose, onConfirm }) {
  const copy = COPY[action] || null;
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const boxRef = useRef(null);

  useEffect(() => {
    if (!copy) return;
    setNote('');
    setError('');
    setSaving(false);
    // Straight into the box: the one thing this dialog is for.
    const t = setTimeout(() => boxRef.current?.focus(), 60);
    return () => clearTimeout(t);
  }, [action, task?._id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!copy || !task) return null;

  const required = !copy.defaultNote;
  const tone = TONES[copy.tone] || TONES.green;
  const Icon = copy.icon;

  const confirm = async () => {
    const said = note.trim();
    if (required && !said) {
      setError('Say why — the other person has nothing else to go on.');
      boxRef.current?.focus();
      return;
    }
    setSaving(true);
    setError('');
    try {
      await onConfirm?.(said || copy.defaultNote);
    } catch (err) {
      // Kept open with what was typed, and the reason under it — a toast behind
      // a modal is easy to miss and the remark would be lost with the dialog.
      setError(err?.response?.data?.message || err?.message || 'That did not go through. Try again.');
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[90] flex items-end justify-center bg-black/40 p-3 sm:items-center"
      onMouseDown={(e) => { if (e.target === e.currentTarget && !saving) onClose?.(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="task-action-title"
        className="w-full max-w-md rounded-2xl bg-white shadow-2xl"
      >
        <div className="flex items-start gap-3 px-5 pb-3 pt-5">
          <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${tone.chip}`}>
            <Icon size={18} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="task-action-title" className="text-base font-semibold text-gray-900">{copy.title}</h2>
            <p className="mt-0.5 truncate text-sm font-medium text-gray-700" title={task.title}>{task.title}</p>
            <p className="mt-1 text-xs text-gray-500">{copy.body}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="rounded-lg p-1.5 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 min-h-[32px] min-w-[32px]"
            aria-label="Close"
          >
            <FiX size={18} />
          </button>
        </div>

        <div className="px-5 pb-2">
          <label htmlFor="task-action-note" className="mb-1 block text-xs font-medium text-gray-600">
            {copy.label}
            {required && <span className="text-red-600"> *</span>}
          </label>
          <textarea
            id="task-action-note"
            ref={boxRef}
            value={note}
            onChange={(e) => { setNote(e.target.value); if (error) setError(''); }}
            onKeyDown={(e) => {
              // Ctrl/Cmd+Enter sends, the way every comment box on the web does.
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); confirm(); }
            }}
            rows={3}
            maxLength={1000}
            placeholder={copy.placeholder}
            className="w-full resize-y rounded-xl border border-gray-200 px-3 py-2 text-sm"
          />
          {error && <p className="mt-1.5 text-xs font-medium text-red-600">{error}</p>}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-gray-100 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="rounded-xl border border-gray-200 px-4 text-sm text-gray-600 transition hover:bg-gray-50 min-h-[40px]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={confirm}
            disabled={saving}
            className={`inline-flex items-center gap-2 rounded-xl px-5 text-sm font-semibold text-white transition disabled:opacity-60 min-h-[40px] ${tone.button}`}
          >
            <Icon size={14} />
            {saving ? 'Saving…' : copy.confirm}
          </button>
        </div>
      </div>
    </div>
  );
}
