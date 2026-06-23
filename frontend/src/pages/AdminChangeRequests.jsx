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
  return d ? new Date(d).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true }) : '';
}

function RequestRow({ r, onDecided }) {
  const isSecret = r.field === 'password';
  const inputType = r.field === 'dateOfBirth' ? 'date' : isSecret ? 'password' : 'text';
  const [applied, setApplied] = useState(isSecret ? '' : r.requestedValue || '');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const decide = async (action) => {
    setErr(''); setBusy(true);
    try {
      const body = { action, decisionNote: note };
      if (action === 'approve') body.appliedValue = applied;
      const { data } = await api.patch(`/change-requests/${r._id}`, body);
      onDecided(data.changeRequest);
    } catch (e) {
      setErr(e.response?.data?.message || 'Action failed');
    } finally {
      setBusy(false);
    }
  };

  const requester = r.requestedBy ? `${r.requestedBy.firstName || ''} ${r.requestedBy.lastName || ''}`.trim() : 'Unknown';

  return (
    <li className="py-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium text-gray-900">
            {r.fieldLabel}
            <span className="ml-2 text-xs font-normal text-gray-500">· {requester} ({r.requestedBy?.role})</span>
          </div>
          <div className="text-xs text-gray-500 mt-1">
            {isSecret ? (
              <span className="italic">New password (hidden)</span>
            ) : (
              <>
                {r.currentValue ? <><span className="line-through">{r.currentValue}</span> → </> : 'Set to '}
                <span className="text-gray-800 font-medium">{r.requestedValue}</span>
              </>
            )}
          </div>
          {r.reason && <div className="text-xs text-gray-400 mt-1 italic">“{r.reason}”</div>}
        </div>
        <div className="text-right shrink-0">
          <span className={`inline-block text-xs px-2 py-0.5 rounded-full border capitalize ${STATUS_BADGE[r.status] || ''}`}>{r.status}</span>
          <div className="text-[11px] text-gray-400 mt-1">{fmt(r.decidedAt || r.createdAt)}</div>
        </div>
      </div>

      {r.status === 'pending' ? (
        <div className="mt-3 bg-gray-50 border border-gray-200 rounded-lg p-3 space-y-2">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">
                Value to apply {isSecret && <span className="text-gray-400">(new password)</span>}
              </label>
              <input
                type={inputType}
                value={applied}
                onChange={(e) => setApplied(e.target.value)}
                className="block w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-gray-300"
                placeholder={isSecret ? 'Enter new password to set' : 'Editable before approving'}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Note <span className="text-gray-400">(optional)</span></label>
              <input
                type="text" value={note}
                onChange={(e) => setNote(e.target.value)}
                className="block w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-gray-300"
                placeholder="Reason / comment to the employee"
              />
            </div>
          </div>
          {err && <div className="text-xs text-red-700">{err}</div>}
          <div className="flex gap-2">
            <button onClick={() => decide('approve')} disabled={busy}
              className="bg-green-600 text-white text-sm px-3 py-1.5 rounded-lg font-medium hover:bg-green-700 disabled:opacity-60">
              {busy ? '…' : 'Approve & apply'}
            </button>
            <button onClick={() => decide('decline')} disabled={busy}
              className="bg-white border border-gray-300 text-gray-700 text-sm px-3 py-1.5 rounded-lg font-medium hover:bg-gray-50 disabled:opacity-60">
              Decline
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-1 text-xs text-gray-500">
          {r.status === 'approved' && !isSecret && r.appliedValue && <>Applied: <span className="text-gray-700">{r.appliedValue}</span>. </>}
          {r.decisionNote && <>Note: {r.decisionNote}. </>}
          {r.decidedBy && <>by {r.decidedBy.firstName} {r.decidedBy.lastName}</>}
        </div>
      )}
    </li>
  );
}

export default function AdminChangeRequests() {
  const user = useAuthStore((s) => s.user);
  const isSuperAdmin = user?.role === 'SuperAdmin';
  const [requests, setRequests] = useState([]);
  const [error, setError] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [filter, setFilter] = useState('pending');

  const load = async () => {
    try {
      const { data } = await api.get('/change-requests/assigned', {
        params: isSuperAdmin && showAll ? { all: 'true' } : {},
      });
      setRequests(data.changeRequests || []);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load requests');
    }
  };

  useEffect(() => { load(); }, [showAll]);

  const onDecided = (updated) => {
    setRequests((rs) => rs.map((r) => (r._id === updated._id ? { ...r, ...updated } : r)));
  };

  const visible = requests.filter((r) => filter === 'all' || r.status === filter);
  const pendingCount = requests.filter((r) => r.status === 'pending').length;

  return (
    <div>
      <PageHeader title="Change Requests" subtitle={`${pendingCount} pending`}>
        {isSuperAdmin && (
          <label className="flex items-center gap-2 text-sm text-gray-600">
            <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
            All admins
          </label>
        )}
      </PageHeader>

      {error && (
        <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>
      )}

      <div className="flex gap-2 mb-3 text-sm">
        {['pending', 'approved', 'declined', 'all'].map((s) => (
          <button key={s} onClick={() => setFilter(s)}
            className={`px-3 py-1 rounded-full border capitalize ${filter === s ? 'accent-bg text-white border-transparent' : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'}`}>
            {s}
          </button>
        ))}
      </div>

      <div className="bg-white shadow rounded-lg p-5">
        {visible.length === 0 ? (
          <p className="text-sm text-gray-400 italic">No {filter === 'all' ? '' : filter} requests.</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {visible.map((r) => (
              <RequestRow key={r._id} r={r} onDecided={onDecided} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
