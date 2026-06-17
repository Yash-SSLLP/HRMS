import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import api from '../api/client';
import { useAuthStore } from '../store/authStore';
import { useThemeStore } from '../store/themeStore';
import { COMPANY_NAME, COMPANY_LOGO } from '../config/company';

export default function Login() {
  const navigate = useNavigate();
  const location = useLocation();
  const setSession = useAuthStore((s) => s.setSession);
  const mode = useThemeStore((s) => s.mode);
  const toggleMode = useThemeStore((s) => s.toggle);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const onSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      const { data } = await api.post('/auth/login', { email, password });
      setSession({ user: data.user, token: data.token });
      const from = location.state?.from?.pathname;
      const dest =
        from ||
        (data.user.role === 'Employee' ? '/employee' : '/admin');
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
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="block w-full rounded-lg border border-gray-300 px-3 py-2.5 focus:ring-2 focus:ring-gray-300 focus:border-gray-400 outline-none"
              autoComplete="current-password"
              placeholder="••••••••"
            />
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
        </p>
      </div>
    </div>
  );
}
