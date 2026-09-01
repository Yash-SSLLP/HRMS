/**
 * AdminSessions — who is signed in right now (Backend only).
 *
 * There is no server-side session table to read: a JWT is valid wherever it is
 * held, so "signed in" is inferred from activity. Every authenticated request
 * stamps `lastSeenAt` (throttled, see middleware/authMiddleware), and an account
 * seen inside the server's active window is holding a live token and using it.
 * The page says as much in as many words rather than implying a precision it
 * does not have.
 *
 * Signing someone out bumps their token version, which invalidates every token
 * already issued to them. They are told NOTHING — no notification, no email, no
 * banner: the next thing they do lands on the login screen and they sign in
 * again as normal. Nothing else about the account changes.
 *
 * Backend: GET /admin/sessions, POST /admin/sessions/:id/logout.
 */
import { useEffect, useState } from 'react';
import { toast } from 'react-toastify';
import api from '../api/client';
import PageHeader from '../components/PageHeader';
import { confirmDialog } from '../components/dialogs';
import { roleLabel } from '../config/roles';

const ROLE_CHIP = {
  SuperAdmin: 'bg-violet-50 text-violet-700 border-violet-200',
  HRManager: 'bg-teal-50 text-teal-700 border-teal-200',
  CEO: 'bg-amber-50 text-amber-800 border-amber-200',
  MD: 'bg-amber-50 text-amber-800 border-amber-200',
  Manager: 'bg-blue-50 text-blue-700 border-blue-200',
};

/** "just now" / "8 min ago" / "3 hr ago" / a date once it stops being useful. */
function ago(iso) {
  if (!iso) return 'never';
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  return new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
}

export default function AdminSessions() {
  const [rows, setRows] = useState([]);
  const [meta, setMeta] = useState({ activeWindowMinutes: 15, activeCount: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [q, setQ] = useState('');
  const [onlyActive, setOnlyActive] = useState(true);

  const load = async ({ quiet } = {}) => {
    if (!quiet) setLoading(true);
    setError('');
    try {
      const { data } = await api.get('/admin/sessions');
      setRows(data.sessions || []);
      setMeta({ activeWindowMinutes: data.activeWindowMinutes, activeCount: data.activeCount });
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // A list of who is here is only useful while it is current, and the page is
    // cheap (one query). Refreshed quietly so the table never blanks under you.
    const t = setInterval(() => load({ quiet: true }), 60_000);
    return () => clearInterval(t);
  }, []);

  const signOut = async (row) => {
    const ok = await confirmDialog({
      title: `Sign ${row.name} out?`,
      message: 'They will be signed out on every device. They can sign straight back in, '
        + 'and they are not told about it.',
      confirmText: 'Sign out',
      tone: 'danger',
    });
    if (!ok) return;
    setBusyId(row._id);
    try {
      await api.post(`/admin/sessions/${row._id}/logout`);
      // Patch the one row rather than refetching the page under the cursor.
      setRows((list) => list.map((r) => (r._id === row._id
        ? { ...r, active: false, lastSeenAt: null } : r)));
      toast.success(`${row.name} was signed out.`);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not sign them out');
    } finally {
      setBusyId(null);
    }
  };

  const needle = q.trim().toLowerCase();
  const visible = rows.filter((r) => {
    if (onlyActive && !r.active) return false;
    if (!needle) return true;
    return `${r.name} ${r.email} ${roleLabel(r.role)}`.toLowerCase().includes(needle);
  });

  return (
    <div>
      <PageHeader
        title="Signed in"
        subtitle="Who is using the portal right now, and signing them out of it"
      />

      <div className="bg-white shadow rounded-lg p-5">
        <div className="flex flex-wrap items-center gap-3 mb-4">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name, email or role…"
            className="border rounded-lg px-3 py-2 text-sm flex-1 min-w-[14rem]"
          />
          <label className="inline-flex items-center gap-2 text-sm text-gray-700 select-none">
            <input type="checkbox" checked={onlyActive} onChange={(e) => setOnlyActive(e.target.checked)} />
            Active only
          </label>
          <span className="text-xs text-gray-500 ml-auto">
            {meta.activeCount} active · {rows.length} seen in 24 hr
          </span>
        </div>

        {/* Said plainly: this is inferred from activity, not a session table, and
            somebody who closed their laptop still counts until the window passes. */}
        <p className="text-xs text-gray-500 mb-4">
          Anyone whose last request was within {meta.activeWindowMinutes} minutes counts as active.
          Signing someone out ends their session on every device; they are not notified and can sign
          back in immediately.
        </p>

        {error && (
          <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg mb-3">{error}</div>
        )}

        {loading ? (
          <p className="text-sm text-gray-400 italic">Loading…</p>
        ) : visible.length === 0 ? (
          <p className="text-sm text-gray-400 italic py-6 text-center">
            {onlyActive ? 'Nobody is active at the moment.' : 'Nobody has signed in in the last 24 hours.'}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left text-gray-600">
                  <th className="px-4 py-3 font-semibold">Account</th>
                  <th className="px-4 py-3 font-semibold">Role</th>
                  <th className="px-4 py-3 font-semibold">Status</th>
                  <th className="px-4 py-3 font-semibold">Last seen</th>
                  <th className="px-4 py-3 font-semibold">Signed in</th>
                  <th className="px-4 py-3 font-semibold text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {visible.map((r) => (
                  <tr key={r._id}>
                    <td className="px-4 py-3">
                      <div className="font-medium text-gray-900">{r.name || '-'}</div>
                      <div className="text-xs text-gray-500">{r.email}</div>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`text-xs px-2 py-0.5 rounded-lg border ${ROLE_CHIP[r.role] || 'bg-gray-50 text-gray-700 border-gray-200'}`}>
                        {roleLabel(r.role)}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      {r.active ? (
                        <span className="inline-flex items-center gap-1.5 text-xs text-green-700">
                          <span className="w-2 h-2 rounded-full bg-green-500 inline-block" aria-hidden="true" />
                          Active
                        </span>
                      ) : (
                        <span className="text-xs text-gray-400">Idle</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-600">{ago(r.lastSeenAt)}</td>
                    <td className="px-4 py-3 text-gray-600">{ago(r.lastLoginAt)}</td>
                    <td className="px-4 py-3 text-right">
                      {r.isSelf ? (
                        <span className="text-xs text-gray-400 italic">That&apos;s you</span>
                      ) : (
                        <button
                          onClick={() => signOut(r)}
                          disabled={busyId === r._id}
                          className="text-red-600 hover:underline disabled:opacity-50"
                        >
                          {busyId === r._id ? 'Signing out…' : 'Sign out'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
