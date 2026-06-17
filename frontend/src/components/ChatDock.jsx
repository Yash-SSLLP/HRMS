import { useEffect, useRef, useState } from 'react';
import api from '../api/client';

const POLL_MS = 4000;

// LinkedIn-style floating messaging dock, pinned to the bottom-right and present
// on every page (rendered once from Layout). Shows an unread badge for unseen
// messages, a collapsible conversation list, incoming requests, a people finder,
// and a chat window popup for the open conversation.
export default function ChatDock() {
  const [open, setOpen] = useState(false);
  const [connections, setConnections] = useState([]);
  const [requests, setRequests] = useState({ incoming: [], outgoing: [] });

  const [showFind, setShowFind] = useState(false);
  const [directory, setDirectory] = useState([]);
  const [dirSearch, setDirSearch] = useState('');

  const [activeId, setActiveId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');

  const activeIdRef = useRef(null);
  const bottomRef = useRef(null);

  const active = connections.find((c) => c.connectionId === activeId);
  const unreadTotal = connections.reduce((sum, c) => sum + (c.unread || 0), 0);

  const loadLists = async () => {
    try {
      const [connRes, reqRes] = await Promise.all([
        api.get('/chat/connections'),
        api.get('/chat/requests'),
      ]);
      setConnections(connRes.data.connections);
      setRequests(reqRes.data);
    } catch {
      // Stay quiet — the dock must not disrupt the page.
    }
  };

  const loadDirectory = async () => {
    try {
      const { data } = await api.get('/chat/directory');
      setDirectory(data.people);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load directory');
    }
  };

  const loadMessages = async (id) => {
    if (!id) return;
    try {
      const { data } = await api.get(`/chat/messages/${id}`);
      if (activeIdRef.current === id) setMessages(data.messages);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load messages');
    }
  };

  // Always poll the lists (so the unread badge updates even while collapsed).
  useEffect(() => {
    loadLists();
    const t = setInterval(loadLists, POLL_MS);
    return () => clearInterval(t);
  }, []);

  // Poll the open conversation.
  useEffect(() => {
    activeIdRef.current = activeId;
    if (!activeId) {
      setMessages([]);
      return undefined;
    }
    loadMessages(activeId);
    const t = setInterval(() => loadMessages(activeId), POLL_MS);
    return () => clearInterval(t);
  }, [activeId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const openConversation = (id) => {
    setActiveId(id);
    setOpen(true);
    // Optimistically clear the unread badge for this thread.
    setConnections((prev) => prev.map((c) => (c.connectionId === id ? { ...c, unread: 0 } : c)));
  };

  const openFind = async () => {
    setShowFind(true);
    setOpen(true);
    await loadDirectory();
  };

  const sendRequest = async (recipientId) => {
    setError('');
    try {
      await api.post('/chat/requests', { recipientId });
      await Promise.all([loadDirectory(), loadLists()]);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not send request');
    }
  };

  const respond = async (id, action) => {
    setError('');
    try {
      await api.patch(`/chat/requests/${id}`, { action });
      await loadLists();
      if (showFind) await loadDirectory();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not respond');
    }
  };

  const send = async (e) => {
    e.preventDefault();
    if (!draft.trim() || !activeId) return;
    setSending(true);
    setError('');
    try {
      const { data } = await api.post('/chat/messages', { connectionId: activeId, body: draft });
      setMessages((prev) => [...prev, data.message]);
      setDraft('');
      loadLists();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not send message');
    } finally {
      setSending(false);
    }
  };

  const filteredDir = directory.filter((p) =>
    p.fullName.toLowerCase().includes(dirSearch.toLowerCase()) ||
    (p.email || '').toLowerCase().includes(dirSearch.toLowerCase())
  );

  return (
    <div className="fixed bottom-0 right-4 z-40 flex items-end gap-3 print:hidden">
      {/* Open conversation window (sits to the left of the messaging panel) */}
      {active && open && (
        <div className="w-80 bg-white border border-gray-200 rounded-t-lg shadow-xl flex flex-col"
          style={{ height: '28rem' }}>
          <div className="flex items-center justify-between px-3 py-2 border-b border-gray-200 bg-gray-50 rounded-t-lg">
            <div className="min-w-0">
              <div className="text-sm font-semibold text-gray-900 truncate">{active.person.fullName}</div>
              <div className="text-[11px] text-gray-500">{active.person.role}</div>
            </div>
            <button onClick={() => setActiveId(null)} className="text-gray-400 hover:text-gray-700 text-lg leading-none">×</button>
          </div>
          <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2 bg-gray-50">
            {messages.map((m) => (
              <div key={m._id} className={`flex ${m.mine ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[80%] px-3 py-2 rounded-lg text-sm ${
                  m.mine ? 'bg-gray-900 text-white' : 'bg-white border border-gray-200 text-gray-800'
                }`}>
                  <div className="break-words">{m.body}</div>
                  <div className={`text-[10px] mt-1 ${m.mine ? 'text-gray-300' : 'text-gray-400'}`}>
                    {new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </div>
                </div>
              </div>
            ))}
            <div ref={bottomRef} />
          </div>
          <form onSubmit={send} className="p-2 border-t border-gray-200 flex gap-2">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Write a message…"
              className="flex-1 border rounded px-2 py-1.5 text-sm"
            />
            <button type="submit" disabled={sending || !draft.trim()}
              className="px-3 py-1.5 bg-gray-900 text-white rounded text-sm disabled:opacity-60">Send</button>
          </form>
        </div>
      )}

      {/* Messaging panel */}
      <div className="w-80 bg-white border border-gray-200 rounded-t-lg shadow-xl">
        <button
          onClick={() => setOpen((o) => !o)}
          className="w-full flex items-center justify-between px-3 py-2 border-b border-gray-200 bg-white rounded-t-lg"
        >
          <span className="flex items-center gap-2 text-sm font-semibold text-gray-900">
            <span>💬</span> Messaging
            {unreadTotal > 0 && (
              <span className="bg-red-600 text-white text-[10px] rounded-full px-1.5 py-0.5 leading-none">
                {unreadTotal > 9 ? '9+' : unreadTotal}
              </span>
            )}
          </span>
          <span className="text-gray-400 text-xs">{open ? '▾' : '▴'}</span>
        </button>

        {open && (
          <div className="flex flex-col" style={{ height: '24rem' }}>
            <div className="flex items-center justify-between px-3 py-2 border-b border-gray-100">
              <span className="text-xs text-gray-500">Your conversations</span>
              <button onClick={openFind} className="text-xs text-blue-600 hover:underline">+ Find people</button>
            </div>

            {error && (
              <div className="mx-3 mt-2 text-xs text-red-700 bg-red-50 border border-red-200 px-2 py-1 rounded">{error}</div>
            )}

            <div className="flex-1 overflow-y-auto">
              {requests.incoming.length > 0 && (
                <div className="p-3 border-b border-gray-100 bg-amber-50">
                  <div className="text-[11px] font-semibold text-amber-800 mb-2">
                    Connection requests ({requests.incoming.length})
                  </div>
                  <div className="space-y-2">
                    {requests.incoming.map((r) => (
                      <div key={r._id} className="flex items-center justify-between gap-2">
                        <span className="text-xs text-gray-800 truncate">{r.from.fullName}</span>
                        <span className="flex gap-1 shrink-0">
                          <button onClick={() => respond(r._id, 'accept')}
                            className="text-[11px] px-2 py-0.5 bg-green-600 text-white rounded">Accept</button>
                          <button onClick={() => respond(r._id, 'decline')}
                            className="text-[11px] px-2 py-0.5 border rounded">Decline</button>
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {connections.length === 0 ? (
                <div className="p-4 text-xs text-gray-500">
                  No conversations yet. Use <strong>Find people</strong> to connect.
                </div>
              ) : connections.map((c) => (
                <button
                  key={c.connectionId}
                  onClick={() => openConversation(c.connectionId)}
                  className={`w-full text-left px-3 py-2 border-b border-gray-50 hover:bg-gray-50 ${
                    activeId === c.connectionId ? 'bg-gray-100' : ''
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className={`text-sm truncate ${c.unread > 0 ? 'font-semibold text-gray-900' : 'text-gray-800'}`}>
                      {c.person.fullName}
                    </span>
                    {c.unread > 0 && (
                      <span className="ml-2 text-[10px] bg-blue-600 text-white rounded-full px-1.5 py-0.5">{c.unread}</span>
                    )}
                  </div>
                  <div className={`text-[11px] truncate ${c.unread > 0 ? 'text-gray-700' : 'text-gray-500'}`}>
                    {c.lastMessage ? `${c.lastMessage.mine ? 'You: ' : ''}${c.lastMessage.body}` : c.person.role}
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Find people modal */}
      {showFind && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50">
          <div className="bg-white rounded-lg shadow-lg w-full max-w-lg p-6">
            <div className="flex items-start justify-between mb-4">
              <h2 className="text-lg font-semibold">Find people</h2>
              <button onClick={() => setShowFind(false)} className="text-gray-400 hover:text-gray-700 text-xl leading-none">×</button>
            </div>
            <input
              value={dirSearch}
              onChange={(e) => setDirSearch(e.target.value)}
              placeholder="Search by name or email…"
              className="w-full border rounded px-3 py-2 text-sm mb-3"
            />
            <div className="max-h-80 overflow-y-auto divide-y divide-gray-100">
              {filteredDir.map((p) => (
                <div key={p._id} className="flex items-center justify-between py-2">
                  <div>
                    <div className="text-sm font-medium text-gray-900">{p.fullName}</div>
                    <div className="text-xs text-gray-500">{p.role} — {p.email}</div>
                  </div>
                  {p.connectionStatus === 'none' && (
                    <button onClick={() => sendRequest(p._id)}
                      className="text-xs px-3 py-1.5 bg-gray-900 text-white rounded hover:bg-gray-700">Connect</button>
                  )}
                  {p.connectionStatus === 'pending-out' && <span className="text-xs text-gray-500">Requested</span>}
                  {p.connectionStatus === 'pending-in' && (
                    <button onClick={() => respond(p.connectionId, 'accept')}
                      className="text-xs px-3 py-1.5 bg-green-600 text-white rounded hover:bg-green-700">Accept</button>
                  )}
                  {p.connectionStatus === 'accepted' && <span className="text-xs text-green-700">Connected</span>}
                </div>
              ))}
              {filteredDir.length === 0 && (
                <div className="py-6 text-center text-sm text-gray-500">No people found</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
