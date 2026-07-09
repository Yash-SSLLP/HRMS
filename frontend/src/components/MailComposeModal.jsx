import { useEffect, useState } from 'react';
import { composeMail } from '../api/compose';
import { confirmDialog } from './dialogs';

/**
 * Editable email composer. Prefills an editable subject + body (with any public
 * document link already inserted). By default it opens the user's Gmail compose
 * tab with the edited values (attachments, if any, download for manual
 * attaching); pass `onSend` to instead deliver the edited mail yourself
 * (e.g. via a server endpoint that sends from the company mailbox).
 *
 * Props:
 *   open, onClose
 *   to                 recipient email(s) (shown read-only)
 *   showCc             when true, shows an editable CC field (comma-separated)
 *   defaultCc          prefilled CC value
 *   defaultSubject     prefilled, editable
 *   defaultBody        prefilled, editable (include the public link here)
 *   attachments        [{ url, filename }] optional — downloaded on send
 *   attachedNames      [string] optional — files the server attaches on send
 *   link               optional public link, shown as a copyable hint
 *   title              modal heading
 *   note               optional explanation shown under the heading
 *   sendLabel          optional label for the send button
 *   onSend             optional async ({ subject, body }) — custom delivery
 *                      instead of opening Gmail compose
 *   onSent             async callback after the mail is sent / compose opened
 */
export default function MailComposeModal({
  open,
  onClose,
  to,
  showCc = false,
  defaultCc = '',
  defaultSubject = '',
  defaultBody = '',
  attachments = [],
  attachedNames = [],
  link,
  title = 'Send email',
  note,
  sendLabel,
  onSend,
  onSent,
}) {
  const [subject, setSubject] = useState(defaultSubject);
  const [body, setBody] = useState(defaultBody);
  const [cc, setCc] = useState(defaultCc);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  // Re-seed the editable fields each time the modal is (re)opened.
  useEffect(() => {
    if (open) {
      setSubject(defaultSubject);
      setBody(defaultBody);
      setCc(defaultCc);
      setError('');
      setCopied(false);
    }
  }, [open, defaultSubject, defaultBody, defaultCc]);

  if (!open) return null;

  const submit = async () => {
    if (!subject.trim() && !(await confirmDialog({ message: 'Send with an empty subject?' }))) return;
    setSending(true);
    setError('');
    try {
      const ccClean = showCc ? cc.trim() : '';
      if (onSend) await onSend({ subject, body, cc: ccClean });
      else await composeMail({ to, cc: ccClean || undefined, subject, body, attachments });
      if (onSent) await onSent();
      onClose();
    } catch (err) {
      setError(err.response?.data?.message || err.message || (onSend ? 'Could not send the email' : 'Could not open the email window'));
    } finally {
      setSending(false);
    }
  };

  const copyLink = async () => {
    try { await navigator.clipboard.writeText(link); setCopied(true); } catch { /* ignore */ }
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-[60] overflow-y-auto py-8">
      <div className="bg-white rounded-xl shadow-lg w-full max-w-xl p-6">
        <div className="flex items-start justify-between mb-1">
          <h2 className="card-title">{title}</h2>
          <button onClick={onClose} className="text-xl leading-none text-gray-400 hover:text-gray-600">×</button>
        </div>
        <p className="text-sm text-gray-500 mb-4">
          {note || (onSend
            ? 'Review and edit the message below · it is sent from the company mailbox.'
            : 'Review and edit the message, then open it in your email to send.')}{' '}
          {to ? <>To: <span className="font-medium text-gray-700">{to}</span></> : null}
        </p>

        <div className="space-y-3">
          {showCc && (
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Cc</label>
              <input
                type="text"
                value={cc}
                onChange={(e) => setCc(e.target.value)}
                placeholder="Add more emails, comma-separated"
                className="block w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-gray-300"
              />
            </div>
          )}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Subject</label>
            <input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              className="block w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-gray-300"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Message</label>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={10}
              className="block w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-gray-300 font-mono"
            />
          </div>

          {link && (
            <div className="flex items-center gap-2 text-xs bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">
              <span className="text-gray-500 shrink-0">Public link:</span>
              <span className="truncate text-gray-700 flex-1">{link}</span>
              <button onClick={copyLink} className="shrink-0 px-2 py-0.5 rounded border border-gray-300 hover:bg-white">
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
          )}

          {attachments.length > 0 && (
            <div className="text-[11px] text-gray-500">
              {attachments.length} attachment{attachments.length > 1 ? 's' : ''} will download so you can attach {attachments.length > 1 ? 'them' : 'it'} in the compose window.
            </div>
          )}

          {attachedNames.length > 0 && (
            <div className="flex items-center gap-2 text-xs bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">
              <span className="text-gray-500 shrink-0">📎 Attached:</span>
              <span className="truncate text-gray-700 flex-1">{attachedNames.join(', ')}</span>
            </div>
          )}

          {error && <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}
        </div>

        <div className="flex justify-end gap-2 pt-4">
          <button onClick={onClose} className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">Cancel</button>
          <button
            onClick={submit}
            disabled={sending}
            className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60"
          >
            {sending ? (onSend ? 'Sending…' : 'Opening…') : (sendLabel || (onSend ? 'Send email' : 'Open in email'))}
          </button>
        </div>
      </div>
    </div>
  );
}
