/**
 * Login — the app's sign-in screen (route /login), used by all roles.
 * POST /auth/login authenticates and stores the session, then routes to the
 * employee vs admin portal by role. Also hosts a "Forgot password?" modal that
 * files a request to HR via POST /password-reset-requests (no email client).
 */
import { useState } from 'react';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import api from '../api/client';
import { useAuthStore } from '../store/authStore';
import { useThemeStore } from '../store/themeStore';
import { COMPANY_NAME, COMPANY_LOGO } from '../config/company';

const BLANK_RESET = {
  name: '', email: '', employeeCode: '', phone: '', designation: '', department: '', reason: '',
};

export default function Login() {
  const navigate = useNavigate();
  const location = useLocation();
  const setSession = useAuthStore((s) => s.setSession);
  const mode = useThemeStore((s) => s.mode);
  const toggleMode = useThemeStore((s) => s.toggle);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  // "Forgot password?" → a form sent to HR/Admin (no email client needed).
  const [showReset, setShowReset] = useState(false);
  const [reset, setReset] = useState(BLANK_RESET);
  const [resetBusy, setResetBusy] = useState(false);
  const [resetMsg, setResetMsg] = useState('');
  const [resetErr, setResetErr] = useState('');

  const openReset = () => {
    setResetErr(''); setResetMsg('');
    setReset({ ...BLANK_RESET, email: email || '' });
    setShowReset(true);
  };

  // Submit the "forgot password" request to HR (no self-service reset link).
  const submitReset = async (e) => {
    e.preventDefault();
    setResetErr(''); setResetMsg('');
    setResetBusy(true);
    try {
      await api.post('/password-reset-requests', reset);
      setReset(BLANK_RESET);
      setResetMsg('Request sent. HR will reset your password and get back to you.');
    } catch (err) {
      setResetErr(err.response?.data?.message || 'Could not send your request. Please try again.');
    } finally {
      setResetBusy(false);
    }
  };

  // Authenticate, persist the session, then redirect by role (honoring any
  // protected route the user was bounced from via location.state.from).
  const onSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      const { data } = await api.post('/auth/login', { email, password });
      setSession({ user: data.user, token: data.token });
      const from = location.state?.from?.pathname;
      // Employees and Managers use the employee portal; admins and the
      // read-only CEO/MD executives use the admin portal.
      const employeePortal = ['Employee', 'Manager'].includes(data.user.role);
      const dest = from || (employeePortal ? '/employee' : '/admin');
      navigate(dest, { replace: true });
    } catch (err) {
      setError(err.response?.data?.message || 'Login failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="relative min-h-full flex items-center justify-center bg-gradient-to-br from-gray-100 via-gray-50 to-blue-50 dark:from-gray-900 dark:via-gray-900 dark:to-gray-800 px-4 py-10">
      <button
        type="button"
        onClick={toggleMode}
        title={mode === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        aria-label={mode === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        className="absolute top-4 right-4 h-10 w-10 flex items-center justify-center rounded-full border border-gray-200 bg-white text-gray-700 shadow-sm hover:bg-gray-50"
      >
        <span className="text-lg leading-none">{mode === 'dark' ? '☀️' : '🌙'}</span>
      </button>

      <div className="w-full max-w-md bg-white shadow-lg rounded-2xl p-8 border border-gray-100">
        <div className="flex flex-col items-center text-center mb-6">
          <img src={COMPANY_LOGO} alt={COMPANY_NAME} className="h-14 w-auto mb-3" />
          <h1 className="text-2xl font-bold text-gray-900">{COMPANY_NAME} HRMS</h1>
          <p className="text-sm text-gray-500 mt-1">Sign in to your account</p>
        </div>

        <form onSubmit={onSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="block w-full rounded-lg border border-gray-300 px-3 py-2.5 focus:ring-2 focus:ring-gray-300 focus:border-gray-400 outline-none"
              autoComplete="email"
              placeholder="you@company.com"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Password</label>
            <div className="relative">
              <input
                type={showPassword ? 'text' : 'password'}
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="block w-full rounded-lg border border-gray-300 px-3 py-2.5 pr-11 focus:ring-2 focus:ring-gray-300 focus:border-gray-400 outline-none"
                autoComplete="current-password"
                placeholder="••••••••"
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                title={showPassword ? 'Hide password' : 'Show password'}
                className="absolute inset-y-0 right-0 px-3 flex items-center text-gray-400 hover:text-gray-700"
              >
                {showPassword ? (
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                    <line x1="1" y1="1" x2="23" y2="23" />
                  </svg>
                ) : (
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                )}
              </button>
            </div>
            <div className="flex justify-end mt-1.5">
              <button
                type="button"
                onClick={openReset}
                className="text-xs font-medium text-gray-500 hover:text-gray-800 hover:underline"
              >
                Forgot password?
              </button>
            </div>
          </div>

          {error && (
            <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="login-submit w-full bg-gray-900 text-white py-2.5 rounded-lg font-medium hover:bg-gray-700 disabled:opacity-60"
          >
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <p className="text-center text-xs text-gray-400 mt-6">
          © {new Date().getFullYear()} {COMPANY_NAME}. All rights reserved.
          {' · '}
          <Link to="/privacy" className="hover:text-gray-600 hover:underline">Privacy Policy</Link>
        </p>
      </div>

      {showReset && (
        <div className="fixed inset-0 bg-black/40 flex items-start justify-center px-4 z-50 overflow-y-auto py-8">
          <div className="bg-white rounded-2xl shadow-lg w-full max-w-lg p-6">
            <div className="flex items-start justify-between mb-1">
              <h2 className="text-lg font-bold text-gray-900">Password reset request</h2>
              <button onClick={() => setShowReset(false)} className="text-gray-400 hover:text-gray-700 text-xl leading-none">×</button>
            </div>
            <p className="text-xs text-gray-500 mb-4">
              Fill in your details and HR will reset your password for you.
            </p>

            {resetMsg ? (
              <div className="space-y-4">
                <div className="text-sm text-green-700 bg-green-50 border border-green-200 px-3 py-2 rounded-lg">
                  {resetMsg}
                </div>
                <div className="flex justify-end">
                  <button onClick={() => setShowReset(false)}
                    className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700">Close</button>
                </div>
              </div>
            ) : (
              <form onSubmit={submitReset} className="space-y-3">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-sm text-gray-700 mb-1">Name *</label>
                    <input required value={reset.name}
                      onChange={(e) => setReset({ ...reset, name: e.target.value })}
                      className="block w-full border border-gray-300 rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-gray-300" />
                  </div>
                  <div>
                    <label className="block text-sm text-gray-700 mb-1">Employee ID *</label>
                    <input required value={reset.employeeCode}
                      onChange={(e) => setReset({ ...reset, employeeCode: e.target.value })}
                      placeholder="SSL 1"
                      className="block w-full border border-gray-300 rounded-lg px-3 py-2 uppercase outline-none focus:ring-2 focus:ring-gray-300" />
                  </div>
                  <div>
                    <label className="block text-sm text-gray-700 mb-1">Email ID *</label>
                    <input type="email" required value={reset.email}
                      onChange={(e) => setReset({ ...reset, email: e.target.value })}
                      className="block w-full border border-gray-300 rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-gray-300" />
                  </div>
                  <div>
                    <label className="block text-sm text-gray-700 mb-1">Phone number *</label>
                    <input required value={reset.phone}
                      onChange={(e) => setReset({ ...reset, phone: e.target.value })}
                      className="block w-full border border-gray-300 rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-gray-300" />
                  </div>
                  <div>
                    <label className="block text-sm text-gray-700 mb-1">Designation *</label>
                    <input required value={reset.designation}
                      onChange={(e) => setReset({ ...reset, designation: e.target.value })}
                      className="block w-full border border-gray-300 rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-gray-300" />
                  </div>
                  <div>
                    <label className="block text-sm text-gray-700 mb-1">Department *</label>
                    <input required value={reset.department}
                      onChange={(e) => setReset({ ...reset, department: e.target.value })}
                      className="block w-full border border-gray-300 rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-gray-300" />
                  </div>
                </div>
                <div>
                  <label className="block text-sm text-gray-700 mb-1">Reason to change <span className="text-gray-400">(optional)</span></label>
                  <textarea rows={2} value={reset.reason}
                    onChange={(e) => setReset({ ...reset, reason: e.target.value })}
                    className="block w-full border border-gray-300 rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-gray-300" />
                </div>

                {resetErr && (
                  <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{resetErr}</div>
                )}

                <div className="flex justify-end gap-2 pt-1">
                  <button type="button" onClick={() => setShowReset(false)}
                    className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">Cancel</button>
                  <button type="submit" disabled={resetBusy}
                    className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60">
                    {resetBusy ? 'Sending…' : 'Send request'}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
