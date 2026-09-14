/**
 * SenderMailboxCard — "Send email from your own mailbox" on My Account.
 *
 * Every mail an HR/admin triggers from HRMS (offer and appointment letters,
 * payslips, interview invites, exit mails, document requests…) normally leaves
 * from the one company Gmail account, with the sender's name as the display
 * name. Here the person connects their OWN Google account; from then on the
 * server sends those mails from their address, and they land in their Sent
 * folder. Disconnecting (or Google revoking the grant) puts them back on the
 * company mailbox — nothing ever fails to send because of this card.
 *
 * Backend: GET /mail-identity, POST /mail-identity/google/start (returns the
 * Google consent URL we navigate to), DELETE /mail-identity, POST
 * /mail-identity/test. Google sends the browser back to the server's callback,
 * which lands here with ?mail=connected|error — read once and cleared.
 *
 * Renders nothing for roles that do not send mail (server SENDER_ROLES).
 */
import { useEffect, useState } from 'react';
import { toast } from 'react-toastify';
import { FiMail, FiCheckCircle, FiAlertTriangle, FiCopy } from 'react-icons/fi';
import api from '../api/client';
import { useAuthStore } from '../store/authStore';
import { confirmDialog } from './dialogs';
import { formatDateTime12 } from '../utils/time';

// Mirrors backend/services/mailIdentity SENDER_ROLES — only to decide whether
// to render at all; the server is the gate.
const SENDER_ROLES = ['SuperAdmin', 'HRManager', 'CEO', 'MD', 'Manager', 'LDManager', 'AccountsManager'];

export default function SenderMailboxCard() {
  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);
  const allowed = SENDER_ROLES.includes(user?.role);
  const isSuperAdmin = user?.role === 'SuperAdmin';

  const [status, setStatus] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [copied, setCopied] = useState(false);

  const load = async () => {
    try {
      const { data } = await api.get('/mail-identity');
      setStatus(data);
      setError('');
      // Keep the signed-in user in step so MailComposeModal can say which
      // mailbox a message will leave from without another request.
      const current = useAuthStore.getState().user;
      if (current) {
        setUser({
          ...current,
          mailIdentity: data.connected
            ? { email: data.email, connectedAt: data.connectedAt, lastError: data.lastError, lastSentAt: data.lastSentAt }
            : null,
        });
      }
    } catch (err) {
      setError(err.response?.data?.message || 'Could not load your mailbox settings');
    }
  };

  useEffect(() => {
    if (!allowed) return;
    load();
    // Landing back from Google: say what happened, once, and clean the URL.
    const params = new URLSearchParams(window.location.search);
    const outcome = params.get('mail');
    if (outcome) {
      if (outcome === 'connected') {
        toast.success(`Connected ${params.get('email') || 'your Google account'}. Emails you send from HRMS now leave from it.`);
      } else {
        toast.error(params.get('reason') || 'Could not connect your Google account.');
      }
      ['mail', 'email', 'reason'].forEach((k) => params.delete(k));
      const qs = params.toString();
      window.history.replaceState({}, '', window.location.pathname + (qs ? `?${qs}` : ''));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allowed]);

  if (!allowed) return null;

  const connect = async () => {
    setBusy('connect');
    try {
      const { data } = await api.post('/mail-identity/google/start', { returnTo: window.location.pathname });
      window.location.assign(data.url);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not start Google sign-in');
      setBusy('');
    }
  };

  const sendTest = async () => {
    setBusy('test');
    try {
      const { data } = await api.post('/mail-identity/test');
      toast.success(`Test email sent from ${data.to} — check that inbox.`);
      await load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'The test email could not be sent');
      await load();
    } finally {
      setBusy('');
    }
  };

  const disconnect = async () => {
    const ok = await confirmDialog({
      message: `Disconnect ${status?.email}? Emails you send from HRMS will go out from the company mailbox again.`,
    });
    if (!ok) return;
    setBusy('disconnect');
    try {
      await api.delete('/mail-identity');
      toast.success('Disconnected. Your emails now go out from the company mailbox.');
      await load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not disconnect');
    } finally {
      setBusy('');
    }
  };

  const copyUri = async () => {
    try { await navigator.clipboard.writeText(status.redirectUri); setCopied(true); } catch { /* ignore */ }
  };

  const companyLine = status?.companySender
    ? <>the company mailbox (<span className="font-medium text-gray-700">{status.companySender}</span>)</>
    : 'the company mailbox';

  return (
    <div className="bg-white shadow rounded-lg p-5 mb-4">
      <div className="flex gap-3">
        <span className="stat-icon bg-teal-100 text-teal-600 shrink-0"><FiMail /></span>
        <div className="flex-1 min-w-0">
          <h2 className="card-title">Send email from your own mailbox</h2>
          <p className="text-sm text-gray-500 mt-1">
            Letters, payslips, interview invites and every other email you send from HRMS
            {status?.connected
              ? <> leave from <span className="font-medium text-gray-700">{status.email}</span> and sit in its Sent folder.</>
              : <> currently leave from {companyLine} with your name on them. Connect your Google account and they will leave from your own address instead, so replies come straight to you.</>}
          </p>

          {error && (
            <div className="mt-3 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>
          )}

          {status && !status.available && (
            <div className="mt-3 text-sm text-amber-800 bg-amber-50 border border-amber-200 px-3 py-2 rounded-lg">
              Google sign-in is not set up on this server yet
              {isSuperAdmin ? ' — set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET in the backend environment.' : '. Ask the Backend team.'}
            </div>
          )}

          {status?.lastError && (
            <div className="mt-3 flex gap-2 text-sm text-amber-800 bg-amber-50 border border-amber-200 px-3 py-2 rounded-lg">
              <FiAlertTriangle className="shrink-0 mt-0.5" />
              <span>
                Google has stopped accepting this connection
                {status.lastErrorAt ? ` (since ${formatDateTime12(status.lastErrorAt)})` : ''}, so your emails are
                going out from {companyLine} for now. Reconnect to fix it.
                <span className="block text-xs text-amber-700 mt-1 break-words">{status.lastError}</span>
              </span>
            </div>
          )}

          {status?.connected && (
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-500">
              <span className={`inline-flex items-center gap-1 ${status.lastError ? 'text-amber-700' : 'text-green-700'}`}>
                <FiCheckCircle size={13} /> Connected {status.connectedAt ? formatDateTime12(status.connectedAt) : ''}
              </span>
              {status.lastSentAt && <span>Last email sent {formatDateTime12(status.lastSentAt)}</span>}
            </div>
          )}

          <div className="mt-4 flex flex-wrap gap-2">
            {status?.connected ? (
              <>
                {status.lastError ? (
                  <button type="button" onClick={connect} disabled={!!busy || !status.available}
                    className="px-4 py-2 text-sm rounded-lg bg-gray-900 text-white hover:bg-gray-700 disabled:opacity-60">
                    {busy === 'connect' ? 'Opening Google…' : 'Reconnect Google account'}
                  </button>
                ) : (
                  <button type="button" onClick={sendTest} disabled={!!busy}
                    className="px-4 py-2 text-sm rounded-lg bg-gray-900 text-white hover:bg-gray-700 disabled:opacity-60">
                    {busy === 'test' ? 'Sending…' : 'Send me a test email'}
                  </button>
                )}
                <button type="button" onClick={disconnect} disabled={!!busy}
                  className="px-4 py-2 text-sm rounded-lg border border-gray-200 text-gray-700 hover:bg-gray-50 disabled:opacity-60">
                  {busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}
                </button>
              </>
            ) : (
              <button type="button" onClick={connect} disabled={!status || !status.available || !!busy}
                className="px-4 py-2 text-sm rounded-lg bg-gray-900 text-white hover:bg-gray-700 disabled:opacity-60">
                {busy === 'connect' ? 'Opening Google…' : 'Connect Google account'}
              </button>
            )}
          </div>

          {!status?.connected && (
            <p className="mt-3 text-[11px] text-gray-400">
              Google will ask you to allow HRMS to <b>send email on your behalf</b> — that is the only permission
              taken; HRMS can never read your inbox. You can disconnect here at any time.
            </p>
          )}

          {/* One-time setup the Backend has to do in Google Cloud Console. Shown
              only to them, and only as the exact string to paste. */}
          {isSuperAdmin && status?.redirectUri && (
            <details className="mt-3 text-xs text-gray-500">
              <summary className="cursor-pointer select-none">Google Cloud setup (Backend only)</summary>
              <p className="mt-2">
                The OAuth client used for company mail must list this callback as an <b>authorised redirect URI</b>,
                and the consent screen must be published (or each HR added as a test user) or Google will
                refuse other accounts:
              </p>
              <div className="mt-2 flex items-center gap-2 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">
                <code className="truncate flex-1 text-gray-700">{status.redirectUri}</code>
                <button type="button" onClick={copyUri}
                  className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-gray-300 hover:bg-white">
                  <FiCopy size={12} /> {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
            </details>
          )}
        </div>
      </div>
    </div>
  );
}
