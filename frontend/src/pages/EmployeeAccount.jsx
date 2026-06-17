import { useEffect, useState } from 'react';
import api from '../api/client';
import PageHeader from '../components/PageHeader';
import { useAuthStore } from '../store/authStore';

const STATUS_BADGE = {
  pending: 'bg-amber-50 text-amber-700 border-amber-200',
  approved: 'bg-green-50 text-green-700 border-green-200',
  declined: 'bg-red-50 text-red-700 border-red-200',
};

function fmt(d) {
  return d ? new Date(d).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
}

export default function EmployeeAccount() {
  const user = useAuthStore((s) => s.user);
  const token = useAuthStore((s) => s.token);
  const setSession = useAuthStore((s) => s.setSession);
  const isSuperAdmin = user?.role === 'SuperAdmin';

  const [fields, setFields] = useState([]);
  const [requests, setRequests] = useState([]);
  const [error, setError] = useState('');

  // Request form state
  const [field, setField] = useState('');
  const [requestedValue, setRequestedValue] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [msg, setMsg] = useState('');

  // SuperAdmin credentials form
  const [cred, setCred] = useState({ email: user?.email || '', currentPassword: '', newPassword: '' });
  const [credMsg, setCredMsg] = useState('');
  const [credErr, setCredErr] = useState('');
  const [credBusy, setCredBusy] = useState(false);

  const selected = fields.find((f) => f.key === field);

  const load = async () => {
    try {
      const [f, r] = await Promise.all([
        api.get('/change-requests/fields'),
        api.get('/change-requests'),
      ]);
      setFields(f.data.fields || []);
      setRequests(r.data.changeRequests || []);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load account data');
    }
  };

  useEffect(() => { load(); }, []);

  const submitRequest = async (e) => {
    e.preventDefault();
    setMsg(''); setError('');
    if (!field || !requestedValue.trim()) {
      setError('Pick a field and enter the new value you want.');
      return;
    }
    setSubmitting(true);
    try {
      await api.post('/change-requests', { field, requestedValue, reason });
      setField(''); setRequestedValue(''); setReason('');
      setMsg('Request submitted. Your admin will review it.');
      await load();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not submit request');
    } finally {
      setSubmitting(false);
    }
  };

  const submitCredentials = async (e) => {
    e.preventDefault();
    setCredMsg(''); setCredErr('');
    setCredBusy(true);
    try {
      const { data } = await api.patch('/auth/me/credentials', cred);
      setSession({ user: data.user, token });
      setCred({ email: data.user.email, currentPassword: '', newPassword: '' });
      setCredMsg('Credentials updated.');
    } catch (err) {
      setCredErr(err.response?.data?.message || 'Could not update credentials');
    } finally {
      setCredBusy(false);
    }
  };

  return (
    <div>
      <PageHeader title="Account & Change Requests" subtitle="Update your login or request changes to your details" />

      {error && (
        <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* --- Credentials --- */}
        <div className={`bg-white shadow rounded-lg p-5 ${isSuperAdmin ? 'lg:col-span-2' : ''}`}>
          <h2 className="card-title mb-3">Login Credentials</h2>
          {isSuperAdmin ? (
            <form onSubmit={submitCredentials} className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
                <input
                  type="email" value={cred.email}
                  onChange={(e) => setCred({ ...cred, email: e.target.value })}
                  className="block w-full rounded-lg border border-gray-300 px-3 py-2 outline-none focus:ring-2 focus:ring-gray-300"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">New password <span className="text-gray-400 font-normal">(leave blank to keep)</span></label>
                <input
                  type="password" value={cred.newPassword} autoComplete="new-password"
                  onChange={(e) => setCred({ ...cred, newPassword: e.target.value })}
                  className="block w-full rounded-lg border border-gray-300 px-3 py-2 outline-none focus:ring-2 focus:ring-gray-300"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Current password</label>
                <input
                  type="password" value={cred.currentPassword} autoComplete="current-password"
                  onChange={(e) => setCred({ ...cred, currentPassword: e.target.value })}
                  className="block w-full rounded-lg border border-gray-300 px-3 py-2 outline-none focus:ring-2 focus:ring-gray-300"
                  placeholder="Required to confirm changes"
                />
              </div>
              {credErr && <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{credErr}</div>}
              {credMsg && <div className="text-sm text-green-700 bg-green-50 border border-green-200 px-3 py-2 rounded-lg">{credMsg}</div>}
              <button type="submit" disabled={credBusy} className="bg-gray-900 text-white px-4 py-2 rounded-lg font-medium hover:bg-gray-700 disabled:opacity-60">
                {credBusy ? 'Saving…' : 'Update credentials'}
              </button>
            </form>
          ) : (
            <div className="text-sm text-gray-600 space-y-2">
              <p>For security, you can't change your own email or password directly.</p>
              <p>Use <span className="font-medium">Request a Change</span> on the right — your admin will review and apply it.</p>
            </div>
          )}
        </div>

        {/* --- Request a change (not for SuperAdmin, who edits directly) --- */}
        {!isSuperAdmin && (
        <div className="bg-white shadow rounded-lg p-5">
          <h2 className="card-title mb-3">Request a Change</h2>
          <form onSubmit={submitRequest} className="space-y-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">What do you want to change?</label>
              <select
                value={field}
                onChange={(e) => { setField(e.target.value); setRequestedValue(''); setMsg(''); }}
                className="block w-full rounded-lg border border-gray-300 px-3 py-2 outline-none focus:ring-2 focus:ring-gray-300"
              >
                <option value="">Select a field…</option>
                {fields.map((f) => (
                  <option key={f.key} value={f.key}>{f.label}</option>
                ))}
              </select>
            </div>

            {selected && !selected.secret && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Current value</label>
                <div className="text-sm text-gray-600 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 min-h-[2.4rem]">
                  {selected.currentValue || <span className="italic text-gray-400">— empty —</span>}
                </div>
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Requested {selected?.label || 'value'}</label>
              <input
                type={selected?.type || (selected?.secret ? 'password' : 'text')}
                value={requestedValue}
                onChange={(e) => setRequestedValue(e.target.value)}
                className="block w-full rounded-lg border border-gray-300 px-3 py-2 outline-none focus:ring-2 focus:ring-gray-300"
                placeholder={selected?.secret ? 'New password' : 'New value'}
                disabled={!field}
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Reason <span className="text-gray-400 font-normal">(optional)</span></label>
              <textarea
                value={reason} rows={2}
                onChange={(e) => setReason(e.target.value)}
                className="block w-full rounded-lg border border-gray-300 px-3 py-2 outline-none focus:ring-2 focus:ring-gray-300"
                placeholder="Why is this change needed?"
              />
            </div>

            {msg && <div className="text-sm text-green-700 bg-green-50 border border-green-200 px-3 py-2 rounded-lg">{msg}</div>}
            <button type="submit" disabled={submitting} className="bg-gray-900 text-white px-4 py-2 rounded-lg font-medium hover:bg-gray-700 disabled:opacity-60">
              {submitting ? 'Submitting…' : 'Submit request'}
            </button>
          </form>
        </div>
        )}
      </div>

      {/* --- My requests --- */}
      {!isSuperAdmin && (
      <div className="bg-white shadow rounded-lg p-5 mt-4">
        <h2 className="card-title mb-3">My Requests</h2>
        {requests.length === 0 ? (
          <p className="text-sm text-gray-400 italic">You haven't raised any change requests.</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {requests.map((r) => (
              <li key={r._id} className="py-3 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-gray-900">{r.fieldLabel}</div>
                  <div className="text-xs text-gray-500 mt-0.5">
                    {r.currentValue ? <><span className="line-through">{r.currentValue}</span> → </> : null}
                    <span className="text-gray-700">{r.appliedValue || r.requestedValue}</span>
                  </div>
                  {r.reason && <div className="text-xs text-gray-400 mt-0.5 italic">“{r.reason}”</div>}
                  {r.decisionNote && <div className="text-xs text-gray-500 mt-0.5">Admin: {r.decisionNote}</div>}
                </div>
                <div className="text-right shrink-0">
                  <span className={`inline-block text-xs px-2 py-0.5 rounded-full border capitalize ${STATUS_BADGE[r.status] || ''}`}>
                    {r.status}
                  </span>
                  <div className="text-[11px] text-gray-400 mt-1">{fmt(r.decidedAt || r.createdAt)}</div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      )}
    </div>
  );
}
