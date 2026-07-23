/**
 * AdminChatExport — SuperAdmin-only tool (admin portal) to pull the full DM
 * transcript between any two users, including messages they deleted from their
 * own view. Loads the user list from GET /admin/users and the transcript from
 * GET /chat/admin/transcript, then exports it client-side as .txt or .json.
 */
import { useEffect, useState } from 'react';
import api from '../api/client';
import { useAuthStore } from '../store/authStore';
import PageHeader from '../components/PageHeader';

const fmt = (d) => (d ? new Date(d).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short', hour12: true }) : '');

export default function AdminChatExport() {
  const me = useAuthStore((s) => s.user);
  const [users, setUsers] = useState([]);
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Populate the two person pickers (SuperAdmin only; others see a gate below).
  useEffect(() => {
    if (me?.role !== 'SuperAdmin') return;
    api.get('/admin/users?active=true')
      .then(({ data }) => setUsers(data.users.sort((x, y) => (x.firstName || '').localeCompare(y.firstName || ''))))
      .catch(() => {});
  }, [me]);

  if (me?.role !== 'SuperAdmin') {
    return (
      <div>
        <PageHeader title="Chat Export" />
        <div className="bg-white shadow rounded-lg p-8 text-center text-gray-500">This tool isn't available for your account.</div>
      </div>
    );
  }

  const nameOf = (id) => {
    const u = users.find((x) => x._id === id);
    return u ? `${u.firstName} ${u.lastName}`.trim() : id;
  };

  const load = async () => {
    setError(''); setResult(null);
    if (!a || !b || a === b) { setError('Pick two different people.'); return; }
    setLoading(true);
    try {
      const { data } = await api.get('/chat/admin/transcript', { params: { userA: a, userB: b } });
      setResult(data);
    } catch (err) { setError(err.response?.data?.message || 'Failed to load transcript'); }
    finally { setLoading(false); }
  };

  const download = (kind) => {
    if (!result) return;
    const base = `chat-${nameOf(a)}-${nameOf(b)}`.replace(/[^a-z0-9]+/gi, '-');
    let blob;
    if (kind === 'json') {
      blob = new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' });
    } else {
      const lines = [
        `Chat transcript: ${nameOf(a)} ↔ ${nameOf(b)}`,
        `Exported: ${new Date().toLocaleString([], { hour12: true })}`,
        '----------------------------------------',
        ...result.messages.map((m) =>
          `[${fmt(m.createdAt)}] ${m.sender?.fullName || 'Unknown'}: ${m.body}` +
          (m.deleted ? `   (deleted by ${m.deletedBy.join(', ') || 'a participant'})` : '')),
      ];
      blob = new Blob([lines.join('\n')], { type: 'text/plain' });
    }
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = `${base}.${kind === 'json' ? 'json' : 'txt'}`;
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div>
      <PageHeader title="Chat Export" subtitle="Extract the full conversation between any two people · including messages they deleted from their own view" />

      <div className="bg-white shadow rounded-lg p-4 mb-4 grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
        <div>
          <label className="block text-xs text-gray-600 mb-1">Person A</label>
          <select value={a} onChange={(e) => setA(e.target.value)} className="block w-full border rounded-lg px-3 py-2 text-sm">
            <option value="">Select…</option>
            {users.map((u) => <option key={u._id} value={u._id}>{u.firstName} {u.lastName} ({u.role})</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-600 mb-1">Person B</label>
          <select value={b} onChange={(e) => setB(e.target.value)} className="block w-full border rounded-lg px-3 py-2 text-sm">
            <option value="">Select…</option>
            {users.map((u) => <option key={u._id} value={u._id}>{u.firstName} {u.lastName} ({u.role})</option>)}
          </select>
        </div>
        <button onClick={load} disabled={loading} className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60">
          {loading ? 'Loading…' : 'Load transcript'}
        </button>
      </div>

      {error && <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}

      {result && (
        <div className="bg-white shadow rounded-lg p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="text-sm text-gray-700">
              <span className="font-medium">{result.meta?.a?.fullName}</span> ↔ <span className="font-medium">{result.meta?.b?.fullName}</span>
              <span className="text-gray-400"> · {result.messages.length} messages</span>
            </div>
            <div className="flex gap-2">
              <button onClick={() => download('txt')} className="text-xs px-3 py-1.5 rounded-lg border border-gray-300 hover:bg-gray-50">Download .txt</button>
              <button onClick={() => download('json')} className="text-xs px-3 py-1.5 rounded-lg border border-gray-300 hover:bg-gray-50">Download .json</button>
            </div>
          </div>
          {result.messages.length === 0 ? (
            <div className="text-center text-gray-500 py-6">No messages between these two.</div>
          ) : (
            <div className="space-y-2 max-h-[60vh] overflow-y-auto">
              {result.messages.map((m) => (
                <div key={m._id} className="border border-gray-100 rounded-lg px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium text-gray-800">{m.sender?.fullName || 'Unknown'}</span>
                    <span className="text-[11px] text-gray-400">{fmt(m.createdAt)}</span>
                  </div>
                  <div className="text-sm text-gray-700 whitespace-pre-wrap break-words">{m.body}</div>
                  {m.deleted && (
                    <div className="text-[11px] text-red-500 mt-0.5">🗑 deleted by {m.deletedBy.join(', ') || 'a participant'}</div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
