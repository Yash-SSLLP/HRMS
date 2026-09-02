/**
 * AdminAccountSecurity — every account's credential state, and setting a new
 * password for one (Backend only).
 *
 * WHY THERE IS NO PASSWORD COLUMN. Passwords are bcrypt-hashed by the User
 * pre-save hook before they ever reach the database, and hashing is one-way:
 * what is stored is a verifier to compare a login attempt against, not the
 * password itself in any recoverable form. The server has never known anybody's
 * password, so there is nothing for a column to read — not for one account, not
 * for any of them. Storing them readably instead would put every employee's
 * password (reused elsewhere, in most cases) in reach of anyone with admin or
 * database access, and this repo already removed one such exposure: `password`
 * was dropped from profile change requests precisely because it sat there in
 * plain text waiting for an approval.
 *
 * So this page answers what a plaintext list is actually reached for — who can
 * still get in, who has never signed in, whose password is old, and who is still
 * sitting on one an admin handed them — and offers the only safe way to act on
 * it: set a new password, tell the person, and make them replace it on the way in.
 *
 * Backend: GET /admin/account-security, POST /admin/users/:id/reset-password.
 */
import { useEffect, useState } from 'react';
import { toast } from 'react-toastify';
import { FiEye, FiEyeOff, FiLock, FiShield } from 'react-icons/fi';
import api from '../api/client';
import PageHeader from '../components/PageHeader';
import { useAuthStore } from '../store/authStore';
import { roleLabel } from '../config/roles';

const ROLE_CHIP = {
  SuperAdmin: 'bg-violet-50 text-violet-700 border-violet-200',
  HRManager: 'bg-teal-50 text-teal-700 border-teal-200',
  CEO: 'bg-amber-50 text-amber-800 border-amber-200',
  MD: 'bg-amber-50 text-amber-800 border-amber-200',
  Manager: 'bg-blue-50 text-blue-700 border-blue-200',
};

const MIN_LEN = 8;

/** "3 days ago" / "4 months ago" / "never" — coarse on purpose; exact stamps aren't the point. */
function ago(iso, never = 'never') {
  if (!iso) return never;
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (days < 1) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`;
  const years = Math.floor(days / 365);
  return `${years} year${years === 1 ? '' : 's'} ago`;
}

function PasswordField({ label, value, onChange, autoFocus }) {
  const [show, setShow] = useState(false);
  return (
    <label className="block">
      <span className="block text-sm text-gray-600 mb-1">{label}</span>
      <span className="relative block">
        <input
          type={show ? 'text' : 'password'}
          value={value}
          autoFocus={autoFocus}
          autoComplete="new-password"
          onChange={(e) => onChange(e.target.value)}
          className="w-full border border-gray-200 rounded-lg px-3 py-2 pr-10 text-sm"
        />
        <button
          type="button"
          onClick={() => setShow((s) => !s)}
          aria-label={show ? 'Hide password' : 'Show password'}
          title={show ? 'Hide password' : 'Show password'}
          className="absolute inset-y-0 right-0 px-3 flex items-center text-gray-400"
        >
          {show ? <FiEyeOff size={16} /> : <FiEye size={16} />}
        </button>
      </span>
    </label>
  );
}

function ResetModal({ row, onClose, onDone }) {
  const [pwd, setPwd] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const tooShort = pwd.length > 0 && pwd.length < MIN_LEN;
  const mismatch = confirm.length > 0 && pwd !== confirm;
  const ready = pwd.length >= MIN_LEN && pwd === confirm && !busy;

  const submit = async (e) => {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError('');
    try {
      await api.post(`/admin/users/${row._id}/reset-password`, { password: pwd });
      toast.success(`New password set for ${row.name}. Tell them what it is — it can't be read back.`);
      onDone();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not set the password');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6 flex flex-col">
        <h3 className="text-lg font-semibold text-gray-900">Set a new password</h3>
        <p className="text-sm text-gray-500 mt-0.5">
          for <span className="font-medium text-gray-700">{row.name}</span>
          {row.employeeCode ? ` · ${row.employeeCode}` : ''}
        </p>

        <form onSubmit={submit} className="mt-4 space-y-3">
          <PasswordField label={`New password (at least ${MIN_LEN} characters)`} value={pwd} onChange={setPwd} autoFocus />
          <PasswordField label="Confirm new password" value={confirm} onChange={setConfirm} />

          {tooShort && <p className="text-xs text-amber-700">Use at least {MIN_LEN} characters.</p>}
          {mismatch && <p className="text-xs text-red-600">The two passwords don&apos;t match.</p>}
          {error && (
            <p className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</p>
          )}

          {/* Both consequences stated before the click, because neither is undoable. */}
          <ul className="text-xs text-gray-500 bg-gray-50 rounded-lg px-3 py-2.5 space-y-1">
            <li>· You must tell {row.name.split(' ')[0] || 'them'} this password yourself — it is hashed on save and cannot be read back from here.</li>
            <li>· They will be signed out on every device.</li>
            <li>· They will have to choose their own password the next time they sign in.</li>
          </ul>

          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm border border-gray-200 rounded-lg">
              Cancel
            </button>
            <button type="submit" disabled={!ready} className="px-4 py-2 text-sm rounded-lg bg-gray-900 text-white disabled:opacity-50">
              {busy ? 'Setting…' : 'Set password'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function AdminAccountSecurity() {
  // SuperAdmin-only, matching the backend gate. Checked on the role rather than a
  // capability because the client's hasPermission answers true for CEO/MD on
  // everything — they read the whole admin portal — and this screen is one of the
  // few (with Permissions and the Audit Log) that they deliberately do not get.
  const me = useAuthStore((s) => s.user);
  const isSuperAdmin = me?.role === 'SuperAdmin';

  const [rows, setRows] = useState([]);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [resetting, setResetting] = useState(null);

  const load = async () => {
    try {
      const { data } = await api.get('/admin/account-security');
      setRows(data.accounts || []);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load accounts');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { if (isSuperAdmin) load(); }, [isSuperAdmin]);

  if (!isSuperAdmin) {
    return (
      <div>
        <PageHeader title="Passwords & Access" subtitle="Account credentials across the portal" />
        <div className="bg-white shadow rounded-lg p-8 text-center text-gray-500">
          This tool isn&apos;t available for your account.
        </div>
      </div>
    );
  }

  const needle = q.trim().toLowerCase();
  const visible = rows.filter((r) => !needle
    || `${r.name} ${r.email} ${r.employeeCode} ${roleLabel(r.role)}`.toLowerCase().includes(needle));

  const flagged = rows.filter((r) => r.mustChangePassword).length;
  const neverIn = rows.filter((r) => !r.lastLoginAt).length;

  return (
    <div>
      <PageHeader
        title="Passwords & Access"
        subtitle="Who can sign in, how old their password is, and setting a new one"
      />

      {/* Says the thing this page will be opened expecting, rather than leaving
          someone hunting for a column that cannot exist. */}
      <div className="bg-white shadow rounded-lg p-4 mb-4 flex gap-3">
        <span className="stat-icon bg-violet-100 text-violet-600 shrink-0"><FiShield /></span>
        <div className="text-sm text-gray-600">
          <p className="font-semibold text-gray-900">Passwords can&apos;t be displayed — not even here.</p>
          <p className="mt-1">
            Every password is hashed before it is stored, which is a one-way operation: the server keeps
            only enough to check a login attempt, never the password itself. Nothing on this screen, in the
            database, or in a backup can turn that back into readable text. If someone is locked out, set
            them a new password below and tell them what you typed — then they replace it on the way in.
          </p>
        </div>
      </div>

      <div className="bg-white shadow rounded-lg p-5">
        <div className="flex flex-wrap items-center gap-3 mb-4">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name, email, employee code or role…"
            className="border rounded-lg px-3 py-2 text-sm flex-1 min-w-[14rem]"
          />
          <span className="text-xs text-gray-500 ml-auto tabular-nums">
            {rows.length} accounts · {flagged} awaiting a change · {neverIn} never signed in
          </span>
        </div>

        {error && (
          <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg mb-3">{error}</div>
        )}

        {loading ? (
          <p className="text-sm text-gray-400 italic py-6 text-center">Loading…</p>
        ) : visible.length === 0 ? (
          <p className="text-sm text-gray-400 italic py-6 text-center">No accounts match that search.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left text-gray-600">
                  <th className="px-4 py-3 font-semibold">Account</th>
                  <th className="px-4 py-3 font-semibold">Signs in with</th>
                  <th className="px-4 py-3 font-semibold">Role</th>
                  <th className="px-4 py-3 font-semibold">Status</th>
                  <th className="px-4 py-3 font-semibold">Last login</th>
                  <th className="px-4 py-3 font-semibold">Password set</th>
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
                    <td className="px-4 py-3 text-gray-600">
                      {/* CEO/MD have no employee profile, so no code — they sign in
                          with the "CEO"/"MD" alias instead (utils/loginIdentity). */}
                      {r.employeeCode
                        ? <span className="font-mono text-xs">{r.employeeCode}</span>
                        : <span className="text-xs text-gray-400 italic">{r.role === 'CEO' || r.role === 'MD' ? r.role : 'email only'}</span>}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`text-xs px-2 py-0.5 rounded-lg border ${ROLE_CHIP[r.role] || 'bg-gray-50 text-gray-700 border-gray-200'}`}>
                        {roleLabel(r.role)}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      {r.isActive ? (
                        <span className="inline-flex items-center gap-1.5 text-xs text-green-700">
                          <span className="w-2 h-2 rounded-full bg-green-500 inline-block" aria-hidden="true" />
                          Active
                        </span>
                      ) : (
                        <span className="text-xs text-gray-400">Deactivated</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-600">{ago(r.lastLoginAt)}</td>
                    <td className="px-4 py-3">
                      {r.mustChangePassword ? (
                        <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-700">
                          <FiLock size={12} /> Admin-set · must change
                        </span>
                      ) : (
                        // Null is "not recorded", not "never" — the field only
                        // starts filling in from the first change after it shipped.
                        <span className="text-gray-600">{ago(r.passwordChangedAt, 'not recorded')}</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {r.isSelf ? (
                        <span className="text-xs text-gray-400 italic">That&apos;s you</span>
                      ) : (
                        <button onClick={() => setResetting(r)} className="text-blue-600 hover:underline">
                          Reset password
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

      {resetting && (
        <ResetModal
          row={resetting}
          onClose={() => setResetting(null)}
          onDone={() => { setResetting(null); load(); }}
        />
      )}
    </div>
  );
}
