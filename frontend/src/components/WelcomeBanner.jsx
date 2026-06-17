import { Fragment } from 'react';
import { Link } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';

// SmartHR-style dashboard greeting banner: avatar, "Welcome Back, <name>" with an
// edit-profile pencil, a subtitle of highlighted stat links, and action buttons.
//   stats:   [{ value, label, to }]
//   actions: [{ label, to, icon, primary }]
function initials(user) {
  const a = (user?.firstName || '').trim()[0] || '';
  const b = (user?.lastName || '').trim()[0] || '';
  return (a + b).toUpperCase() || 'U';
}

export default function WelcomeBanner({ stats = [], actions = [], editTo = '/employee/profile' }) {
  const user = useAuthStore((s) => s.user);

  return (
    <div className="bg-white shadow rounded-lg p-4 sm:p-5 mb-4 flex flex-col sm:flex-row sm:items-center gap-4">
      <span
        className="avatar-circle accent-bg text-white shrink-0"
        style={{ width: '3.25rem', height: '3.25rem', fontSize: '1.05rem' }}
      >
        {initials(user)}
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-bold text-gray-900 truncate">
            Welcome Back, {user?.firstName || 'there'}
          </h1>
          <Link
            to={editTo}
            title="Edit profile"
            className="inline-flex items-center justify-center w-6 h-6 rounded-md text-gray-400 hover:text-gray-700 hover:bg-gray-100"
            aria-label="Edit profile"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
            </svg>
          </Link>
        </div>

        {stats.length > 0 && (
          <p className="text-sm text-gray-500 mt-0.5">
            You have{' '}
            {stats.map((s, i) => (
              <Fragment key={s.label}>
                {i > 0 && ' & '}
                <Link to={s.to} className="accent-text font-semibold underline">{s.value ?? 0}</Link>{' '}
                {s.label}
              </Fragment>
            ))}
          </p>
        )}
      </div>

      {actions.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 shrink-0">
          {actions.map((a) => (
            <Link
              key={a.label}
              to={a.to}
              className={`inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium ${
                a.primary
                  ? 'accent-bg text-white hover:opacity-90'
                  : 'border border-gray-300 text-gray-700 hover:bg-gray-50'
              }`}
            >
              {a.icon && <span aria-hidden="true">{a.icon}</span>}
              {a.label}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
