/**
 * ChangePassword — the screen a user is held on while `user.mustChangePassword`
 * is set.
 *
 * TWO paths raise that flag and this copy must be true for both: a SuperAdmin
 * RESET the password (it is then known to at least two people, so it is only ever
 * a way back IN), or a SuperAdmin merely ASKED for a change, in which case the
 * person's own password still works and nobody gave them anything. The wording
 * below therefore never asserts a reset happened.
 *
 * ProtectedRoute redirects every portal route here until the flag clears, and the
 * flag clears server-side the moment PATCH /auth/me/credentials succeeds.
 *
 * The sign-out at the end is not a failure mode, it is the system working: setting
 * a password bumps `tokenVersion`, which invalidates every token issued before it
 * — including the one this very page is holding. The mobile app's Settings sheet
 * ends the same way and says the same thing, so the two clients behave alike.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'react-toastify';
import { FiEye, FiEyeOff, FiLock } from 'react-icons/fi';
import api from '../api/client';
import { useAuthStore } from '../store/authStore';

const MIN_LEN = 8;

function Field({ label, value, onChange, autoFocus, autoComplete }) {
  const [show, setShow] = useState(false);
  return (
    <label className="block">
      <span className="block text-sm text-gray-600 mb-1">{label}</span>
      <span className="relative block">
        <input
          type={show ? 'text' : 'password'}
          value={value}
          autoFocus={autoFocus}
          autoComplete={autoComplete}
          onChange={(e) => onChange(e.target.value)}
          className="w-full border border-gray-200 rounded-lg px-3 py-2 pr-10 text-sm"
        />
        <button
          type="button"
          onClick={() => setShow((s) => !s)}
          aria-label={show ? 'Hide password' : 'Show password'}
          className="absolute inset-y-0 right-0 px-3 flex items-center text-gray-400"
        >
          {show ? <FiEyeOff size={16} /> : <FiEye size={16} />}
        </button>
      </span>
    </label>
  );
}

export default function ChangePassword() {
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const navigate = useNavigate();

  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const mismatch = confirm.length > 0 && next !== confirm;
  // Refusing the same password back is the whole point: re-entering it would
  // leave the account exactly where it was.
  const sameAsCurrent = next.length > 0 && next === current;
  const ready = current.length > 0 && next.length >= MIN_LEN && next === confirm && !sameAsCurrent && !busy;

  const submit = async (e) => {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError('');
    try {
      await api.patch('/auth/me/credentials', { currentPassword: current, newPassword: next });
      toast.success('Password changed. Sign in with your new one.');
      // The token this page holds died the moment the server saved, so sign out
      // deliberately rather than letting the next request discover it as a 401.
      logout();
      navigate('/login', { replace: true });
    } catch (err) {
      setError(err.response?.data?.message || 'Could not change the password');
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4" style={{ background: 'var(--bg)' }}>
      <div className="bg-white shadow rounded-lg p-6 w-full max-w-md">
        <span className="stat-icon bg-amber-100 text-amber-600"><FiLock /></span>
        <h1 className="text-lg font-semibold text-gray-900 mt-3">Choose your own password</h1>
        <p className="text-sm text-gray-500 mt-1">
          {user?.firstName ? `${user.firstName}, you have` : 'You have'} been asked to set a new password
          before carrying on. Choose one only you know.
        </p>

        <form onSubmit={submit} className="mt-5 space-y-3">
          <Field
            label="Your current password"
            value={current}
            onChange={setCurrent}
            autoFocus
            autoComplete="current-password"
          />
          <Field
            label={`New password (at least ${MIN_LEN} characters)`}
            value={next}
            onChange={setNext}
            autoComplete="new-password"
          />
          <Field label="Confirm new password" value={confirm} onChange={setConfirm} autoComplete="new-password" />

          {sameAsCurrent && (
            <p className="text-xs text-amber-700">
              The new password has to differ from your current one.
            </p>
          )}
          {mismatch && <p className="text-xs text-red-600">The two passwords don&apos;t match.</p>}
          {error && (
            <p className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</p>
          )}

          <p className="text-xs text-gray-500 bg-gray-50 rounded-lg px-3 py-2.5">
            You&apos;ll be signed out once it is saved — sign back in with your new password.
          </p>

          <button
            type="submit"
            disabled={!ready}
            className="w-full px-4 py-2.5 text-sm rounded-lg bg-gray-900 text-white disabled:opacity-50"
          >
            {busy ? 'Saving…' : 'Save and sign in again'}
          </button>
        </form>
      </div>
    </div>
  );
}
