import { useEffect, useState } from 'react';
import api from '../api/client';
import PageHeader from '../components/PageHeader';

const STATUS_BADGE = {
  Open: 'bg-amber-50 text-amber-700 border-amber-200',
  Resolved: 'bg-green-50 text-green-700 border-green-200',
};

function fmt(d) {
  return d ? new Date(d).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true }) : '';
}

function Field({ label, value }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] uppercase tracking-wide text-gray-400">{label}</div>
      <div className="text-sm text-gray-800 break-words">{value || '-'}</div>
    </div>
  );
}

function RequestCard({ r, onResolved }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [resetting, setResetting] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [showPwd, setShowPwd] = useState(false);

  const resolve = async () => {
    setErr(''); setBusy(true);
    try {
      const { data } = await api.patch(`/password-reset-requests/${r._id}/resolve`);
      onResolved(data.request);
    } catch (e) {
      setErr(e.response?.data?.message || 'Could not resolve');
    } finally {
      setBusy(false);
    }
  };

  const doReset = async () => {
    setErr('');
    if (!newPassword || newPassword.length < 8) {
      setErr('New password must be at least 8 characters.');
      return;
    }
    setBusy(true);
    try {
      const { data } = await api.patch(`/password-reset-requests/${r._id}/reset`, { newPassword });
      onResolved(data.request);
    } catch (e) {
      setErr(e.response?.data?.message || 'Could not reset password');
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="py-4">
      <div className="flex items-start justify-between gap-3">
        <div className="text-sm font-medium text-gray-900">
          {r.name}
          <span className="ml-2 text-xs font-normal text-gray-500">· {r.employeeCode}</span>
        </div>
        <div className="text-right shrink-0">
          <span className={`inline-block text-xs px-2 py-0.5 rounded-full border ${STATUS_BADGE[r.status] || ''}`}>{r.status}</span>
          <div className="text-[11px] text-gray-400 mt-1">{fmt(r.createdAt)}</div>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-3 bg-gray-50 border border-gray-200 rounded-lg p-3">
        <Field label="Email" value={r.email} />
        <Field label="Phone" value={r.phone} />
        <Field label="Designation" value={r.designation} />
        <Field label="Department" value={r.department} />
      </div>
      {r.reason && <div className="text-xs text-gray-500 mt-2 italic">“{r.reason}”</div>}

      {err && <div className="text-xs text-red-700 mt-2">{err}</div>}

      {r.status === 'Open' ? (
        <div className="mt-3 space-y-2">
          {resetting ? (
            <div className="flex flex-wrap items-end gap-2">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">New password</label>
                <div className="relative">
                  <input type={showPwd ? 'text' : 'password'} value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="At least 8 characters"
                    className="block w-56 max-w-full rounded-lg border border-gray-300 px-3 py-1.5 pr-10 text-sm outline-none focus:ring-2 focus:ring-gray-300" />
                  <button type="button" onClick={() => setShowPwd((s) => !s)}
                    className="absolute inset-y-0 right-0 px-2.5 flex items-center text-gray-400 hover:text-gray-700"
                    aria-label={showPwd ? 'Hide password' : 'Show password'}
                    title={showPwd ? 'Hide password' : 'Show password'}>
                    {showPwd ? (
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                        <line x1="1" y1="1" x2="23" y2="23" />
                      </svg>
                    ) : (
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                        <circle cx="12" cy="12" r="3" />
                      </svg>
                    )}
                  </button>
                </div>
              </div>
              <button onClick={doReset} disabled={busy}
                className="bg-gray-900 text-white text-sm px-3 py-1.5 rounded-lg font-medium hover:bg-gray-700 disabled:opacity-60">
                {busy ? '…' : 'Save & resolve'}
              </button>
              <button onClick={() => { setResetting(false); setNewPassword(''); setErr(''); }}
                className="bg-white border border-gray-300 text-gray-700 text-sm px-3 py-1.5 rounded-lg font-medium hover:bg-gray-50">
                Cancel
              </button>
            </div>
          ) : (
            <div className="flex gap-2">
              <button onClick={() => setResetting(true)}
                className="bg-blue-600 text-white text-sm px-3 py-1.5 rounded-lg font-medium hover:bg-blue-700">
                Set new password
              </button>
              <button onClick={resolve} disabled={busy}
                className="bg-green-600 text-white text-sm px-3 py-1.5 rounded-lg font-medium hover:bg-green-700 disabled:opacity-60">
                {busy ? '…' : 'Mark resolved'}
              </button>
            </div>
          )}
          <p className="text-[11px] text-gray-400">
            “Set new password” changes the employee's password here and resolves the request (they're logged out everywhere). Or reset it under Users and just mark it resolved.
          </p>
        </div>
      ) : (
        <div className="mt-2 text-xs text-gray-500">
          Resolved {fmt(r.resolvedAt)}
          {r.resolvedBy && <> by {r.resolvedBy.firstName} {r.resolvedBy.lastName}</>}
        </div>
      )}
    </li>
  );
}

export default function AdminPasswordResets() {
  const [requests, setRequests] = useState([]);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('Open');

  const load = async () => {
    try {
      const { data } = await api.get('/password-reset-requests');
      setRequests(data.requests || []);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load requests');
    }
  };

  useEffect(() => { load(); }, []);

  const onResolved = (updated) => {
    setRequests((rs) => rs.map((r) => (r._id === updated._id ? { ...r, ...updated } : r)));
  };

  const visible = requests.filter((r) => filter === 'all' || r.status === filter);
  const openCount = requests.filter((r) => r.status === 'Open').length;

  return (
    <div>
      <PageHeader title="Password Reset Requests" subtitle={`${openCount} open`} />

      {error && (
        <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>
      )}

      <div className="flex gap-2 mb-3 text-sm">
        {['Open', 'Resolved', 'all'].map((s) => (
          <button key={s} onClick={() => setFilter(s)}
            className={`px-3 py-1 rounded-full border capitalize ${filter === s ? 'accent-bg text-white border-transparent' : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'}`}>
            {s}
          </button>
        ))}
      </div>

      <div className="bg-white shadow rounded-lg p-5">
        {visible.length === 0 ? (
          <p className="text-sm text-gray-400 italic">No {filter === 'all' ? '' : filter.toLowerCase()} requests.</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {visible.map((r) => (
              <RequestCard key={r._id} r={r} onResolved={onResolved} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
