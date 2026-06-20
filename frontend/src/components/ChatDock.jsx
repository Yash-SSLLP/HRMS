import { useEffect, useRef, useState } from 'react';
import api from '../api/client';
import { useThemeStore } from '../store/themeStore';

const POLL_MS = 4000;

// WhatsApp-inspired colour palettes (light & dark).
const WA_LIGHT = {
  header: '#008069', headerText: '#ffffff',
  panel: '#ffffff', listHover: '#f5f6f6',
  chatBg: '#efeae2', bubbleOut: '#d9fdd3', bubbleIn: '#ffffff',
  text: '#111b21', sub: '#667781', border: '#e9edef',
  badge: '#25d366', inputBg: '#ffffff', composerBg: '#f0f2f5',
};
const WA_DARK = {
  header: '#202c33', headerText: '#e9edef',
  panel: '#111b21', listHover: '#202c33',
  chatBg: '#0b141a', bubbleOut: '#005c4b', bubbleIn: '#202c33',
  text: '#e9edef', sub: '#8696a0', border: '#2a3942',
  badge: '#25d366', inputBg: '#2a3942', composerBg: '#202c33',
};

// Subtle WhatsApp-style chat wallpaper (faint dotted texture).
const CHAT_PATTERN =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='40' height='40'%3E%3Ccircle cx='3' cy='3' r='1.2' fill='%23000' fill-opacity='0.03'/%3E%3C/svg%3E\")";

function initials(name = '') {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] || '') + (parts[1]?.[0] || '')).toUpperCase() || '?';
}

// WhatsApp delivery-status ticks for outgoing messages.
//  sent → single grey tick · delivered → double grey · seen → double blue.
const TICK_SINGLE =
  'M10.91 3.316l-.478-.372a.365.365 0 0 0-.51.063L4.566 9.879a.32.32 0 0 1-.484.033L1.891 7.769a.366.366 0 0 0-.515.006l-.423.433a.364.364 0 0 0 .006.514l3.258 3.185c.143.14.361.125.484-.033l6.272-8.048a.365.365 0 0 0-.063-.51z';
const TICK_DOUBLE =
  'M15.01 3.316l-.478-.372a.365.365 0 0 0-.51.063L8.666 9.879a.32.32 0 0 1-.484.033l-.358-.325a.319.319 0 0 0-.484.032l-.378.483a.418.418 0 0 0 .036.541l1.32 1.266c.143.14.361.125.484-.033l6.272-8.048a.366.366 0 0 0-.063-.51zm-4.1 0l-.478-.372a.365.365 0 0 0-.51.063L4.566 9.879a.32.32 0 0 1-.484.033L1.891 7.769a.366.366 0 0 0-.515.006l-.423.433a.364.364 0 0 0 .006.514l3.258 3.185c.143.14.361.125.484-.033l6.272-8.048a.365.365 0 0 0-.063-.51z';

function MsgTicks({ status, mode }) {
  if (!status) return null;
  const seen = status === 'seen';
  const color = seen ? '#53bdeb' : mode === 'dark' ? '#8696a0' : '#667781';
  return (
    <svg
      viewBox="0 0 16 15" width="15" height="14"
      style={{ color, display: 'inline-block', verticalAlign: '-2px', marginLeft: 1 }}
      role="img" aria-label={status === 'sent' ? 'Sent' : status === 'delivered' ? 'Delivered' : 'Seen'}
    >
      <path fill="currentColor" d={status === 'sent' ? TICK_SINGLE : TICK_DOUBLE} />
    </svg>
  );
}

function Avatar({ name, size = 38 }) {
  return (
    <span
      className="inline-flex items-center justify-center rounded-full font-semibold shrink-0"
      style={{ width: size, height: size, fontSize: size * 0.38, background: '#6b7c85', color: '#fff' }}
    >
      {initials(name)}
    </span>
  );
}

// Floating WhatsApp-style messaging dock, pinned bottom-right, rendered once from
// Layout. On phones it collapses to a circular FAB and opens full-screen.
export default function ChatDock() {
  const mode = useThemeStore((s) => s.mode);
  const wa = mode === 'dark' ? WA_DARK : WA_LIGHT;

  const [isMobile, setIsMobile] = useState(false);
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

  // Track phone-sized viewports so the dock can become a circular FAB.
  useEffect(() => {
    const update = () => setIsMobile(window.innerWidth <= 639);
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

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

  const fmtTime = (d) => new Date(d).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  // --- Phone, collapsed: a circular WhatsApp-style floating button ---
  if (isMobile && !open && !showFind) {
    return (
      <button
        onClick={() => setOpen(true)}
        aria-label="Open chats"
        className="fixed bottom-5 right-5 z-40 w-14 h-14 rounded-full shadow-xl flex items-center justify-center print:hidden"
        style={{ background: '#008069' }}
      >
        <svg width="26" height="26" viewBox="0 0 24 24" fill="#fff">
          <path d="M12 2a10 10 0 00-8.94 14.47L2 22l5.7-1.5A10 10 0 1012 2zm0 18a8 8 0 01-4.1-1.13l-.29-.17-3.39.89.9-3.3-.19-.3A8 8 0 1112 20z" />
        </svg>
        {unreadTotal > 0 && (
          <span className="absolute -top-0.5 -right-0.5 text-[10px] rounded-full min-w-[20px] h-5 px-1 flex items-center justify-center font-bold"
            style={{ background: wa.badge, color: '#0b141a', border: '2px solid #fff' }}>
            {unreadTotal > 9 ? '9+' : unreadTotal}
          </span>
        )}
      </button>
    );
  }

  // Sizing differs between the phone full-screen view and the desktop dock.
  const windowClass = isMobile
    ? 'absolute inset-0 flex flex-col'
    : 'w-80 max-w-[92vw] rounded-t-xl shadow-2xl flex flex-col overflow-hidden';
  const windowStyle = isMobile
    ? { background: wa.chatBg }
    : { height: '28rem', background: wa.chatBg, border: `1px solid ${wa.border}` };
  const panelClass = isMobile
    ? 'absolute inset-0 flex flex-col'
    : 'w-80 max-w-[92vw] rounded-t-xl shadow-2xl overflow-hidden';

  return (
    <div className={isMobile ? 'fixed inset-0 z-50 print:hidden' : 'fixed bottom-0 right-4 z-40 flex items-end gap-3 print:hidden'}>
      {/* Open conversation window */}
      {active && open && (
        <div className={windowClass} style={windowStyle}>
          {/* Header */}
          <div className="flex items-center gap-2 px-3 py-2" style={{ background: wa.header }}>
            <button onClick={() => setActiveId(null)} className="text-2xl leading-none px-1" style={{ color: wa.headerText }} aria-label="Back">
              {isMobile ? '‹' : '×'}
            </button>
            <Avatar name={active.person.fullName} size={36} />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold truncate" style={{ color: wa.headerText }}>{active.person.fullName}</div>
              <div className="text-[11px] truncate" style={{ color: mode === 'dark' ? '#8696a0' : 'rgba(255,255,255,.8)' }}>
                {active.person.role}
              </div>
            </div>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-3 py-3 space-y-1.5" style={{ backgroundImage: CHAT_PATTERN, backgroundColor: wa.chatBg }}>
            {messages.map((m) => (
              <div key={m._id} className={`flex ${m.mine ? 'justify-end' : 'justify-start'}`}>
                <div
                  className="max-w-[78%] px-2.5 py-1.5 text-sm shadow-sm"
                  style={{
                    background: m.mine ? wa.bubbleOut : wa.bubbleIn,
                    color: m.mine ? (mode === 'dark' ? wa.text : '#111b21') : wa.text,
                    borderRadius: m.mine ? '8px 8px 2px 8px' : '8px 8px 8px 2px',
                  }}
                >
                  <span className="break-words whitespace-pre-wrap">{m.body}</span>
                  <span className="text-[10px] ml-2 align-bottom inline-flex items-center" style={{ color: wa.sub }}>
                    {fmtTime(m.createdAt)}
                    {m.mine && <MsgTicks status={m.status} mode={mode} />}
                  </span>
                </div>
              </div>
            ))}
            <div ref={bottomRef} />
          </div>

          {/* Composer */}
          <form onSubmit={send} className="flex items-center gap-2 p-2" style={{ background: wa.composerBg }}>
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Type a message"
              className="flex-1 rounded-full px-4 py-2 text-sm outline-none"
              style={{ background: wa.inputBg, color: wa.text, border: `1px solid ${wa.border}` }}
            />
            <button
              type="submit" disabled={sending || !draft.trim()}
              className="w-10 h-10 rounded-full flex items-center justify-center shrink-0 disabled:opacity-50"
              style={{ background: '#008069', color: '#fff' }}
              aria-label="Send"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" /></svg>
            </button>
          </form>
        </div>
      )}

      {/* Messaging panel — hidden on phone while a conversation is open (the chat
          window takes the full screen there). */}
      {(!isMobile || !active) && (
        <div className={panelClass} style={{ background: wa.panel, border: isMobile ? 'none' : `1px solid ${wa.border}` }}>
          {/* Green header */}
          <div className="flex items-center gap-2 px-3 py-2.5" style={{ background: wa.header }}>
            <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-2 flex-1 min-w-0 text-left">
              <span className="w-8 h-8 rounded-full flex items-center justify-center" style={{ background: 'rgba(255,255,255,.18)' }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill={wa.headerText}><path d="M12 2a10 10 0 00-8.94 14.47L2 22l5.7-1.5A10 10 0 1012 2zm0 18a8 8 0 01-4.1-1.13l-.29-.17-3.39.89.9-3.3-.19-.3A8 8 0 1112 20z"/></svg>
              </span>
              <span className="text-sm font-semibold" style={{ color: wa.headerText }}>Chats</span>
              {unreadTotal > 0 && (
                <span className="text-[10px] rounded-full px-1.5 py-0.5 leading-none font-bold" style={{ background: wa.badge, color: '#0b141a' }}>
                  {unreadTotal > 9 ? '9+' : unreadTotal}
                </span>
              )}
            </button>
            <button onClick={openFind} title="Find people"
              className="w-8 h-8 rounded-full flex items-center justify-center hover:opacity-90" style={{ background: 'rgba(255,255,255,.18)', color: wa.headerText }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6z"/></svg>
            </button>
            <button onClick={() => setOpen((o) => !o)} className="px-1 text-sm" style={{ color: wa.headerText }} aria-label="Collapse">
              {isMobile ? '×' : (open ? '▾' : '▴')}
            </button>
          </div>

          {open && (
            <div className="flex flex-col" style={isMobile ? { flex: 1, minHeight: 0, background: wa.panel } : { height: '24rem', background: wa.panel }}>
              {error && (
                <div className="mx-3 mt-2 text-xs text-red-700 bg-red-50 border border-red-200 px-2 py-1 rounded">{error}</div>
              )}

              <div className="flex-1 overflow-y-auto">
                {requests.incoming.length > 0 && (
                  <div className="p-3" style={{ borderBottom: `1px solid ${wa.border}`, background: mode === 'dark' ? '#182229' : '#fff8e6' }}>
                    <div className="text-[11px] font-semibold mb-2" style={{ color: wa.sub }}>
                      Connection requests ({requests.incoming.length})
                    </div>
                    <div className="space-y-2">
                      {requests.incoming.map((r) => (
                        <div key={r._id} className="flex items-center gap-2">
                          <Avatar name={r.from.fullName} size={30} />
                          <span className="text-xs truncate flex-1" style={{ color: wa.text }}>{r.from.fullName}</span>
                          <span className="flex gap-1 shrink-0">
                            <button onClick={() => respond(r._id, 'accept')}
                              className="text-[11px] px-2.5 py-1 rounded-full text-white" style={{ background: '#008069' }}>Accept</button>
                            <button onClick={() => respond(r._id, 'decline')}
                              className="text-[11px] px-2.5 py-1 rounded-full" style={{ border: `1px solid ${wa.border}`, color: wa.sub }}>Decline</button>
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {connections.length === 0 ? (
                  <div className="p-6 text-center text-xs" style={{ color: wa.sub }}>
                    No chats yet. Tap <span className="font-semibold">＋</span> in the header to find people.
                  </div>
                ) : connections.map((c) => (
                  <button
                    key={c.connectionId}
                    onClick={() => openConversation(c.connectionId)}
                    className="w-full text-left px-3 py-2.5 flex items-center gap-3 transition-colors"
                    style={{
                      borderBottom: `1px solid ${wa.border}`,
                      background: activeId === c.connectionId ? wa.listHover : 'transparent',
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = wa.listHover; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = activeId === c.connectionId ? wa.listHover : 'transparent'; }}
                  >
                    <Avatar name={c.person.fullName} size={42} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm truncate font-medium" style={{ color: wa.text }}>{c.person.fullName}</span>
                        {c.lastMessage && (
                          <span className="text-[10px] shrink-0" style={{ color: c.unread > 0 ? wa.badge : wa.sub }}>
                            {fmtTime(c.lastMessage.createdAt)}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[12px] truncate" style={{ color: wa.sub }}>
                          {c.lastMessage ? `${c.lastMessage.mine ? 'You: ' : ''}${c.lastMessage.body}` : c.person.role}
                        </span>
                        {c.unread > 0 && (
                          <span className="text-[10px] rounded-full min-w-[18px] h-[18px] px-1 flex items-center justify-center font-bold shrink-0"
                            style={{ background: wa.badge, color: '#0b141a' }}>{c.unread}</span>
                        )}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Find people modal */}
      {showFind && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50">
          <div className="rounded-xl shadow-lg w-full max-w-lg p-6" style={{ background: wa.panel }}>
            <div className="flex items-start justify-between mb-4">
              <h2 className="text-lg font-semibold" style={{ color: wa.text }}>Find people</h2>
              <button onClick={() => setShowFind(false)} className="text-xl leading-none" style={{ color: wa.sub }}>×</button>
            </div>
            <input
              value={dirSearch}
              onChange={(e) => setDirSearch(e.target.value)}
              placeholder="Search by name or email…"
              className="w-full rounded-full px-4 py-2 text-sm mb-3 outline-none"
              style={{ background: wa.inputBg, color: wa.text, border: `1px solid ${wa.border}` }}
            />
            <div className="max-h-80 overflow-y-auto">
              {filteredDir.map((p) => (
                <div key={p._id} className="flex items-center gap-3 py-2" style={{ borderBottom: `1px solid ${wa.border}` }}>
                  <Avatar name={p.fullName} size={38} />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium truncate" style={{ color: wa.text }}>{p.fullName}</div>
                    <div className="text-xs truncate" style={{ color: wa.sub }}>{p.role} — {p.email}</div>
                  </div>
                  {p.connectionStatus === 'none' && (
                    <button onClick={() => sendRequest(p._id)}
                      className="text-xs px-3 py-1.5 rounded-full text-white shrink-0" style={{ background: '#008069' }}>Connect</button>
                  )}
                  {p.connectionStatus === 'pending-out' && <span className="text-xs shrink-0" style={{ color: wa.sub }}>Requested</span>}
                  {p.connectionStatus === 'pending-in' && (
                    <button onClick={() => respond(p.connectionId, 'accept')}
                      className="text-xs px-3 py-1.5 rounded-full text-white shrink-0" style={{ background: '#008069' }}>Accept</button>
                  )}
                  {p.connectionStatus === 'accepted' && <span className="text-xs shrink-0" style={{ color: '#25d366' }}>✓ Chatting</span>}
                </div>
              ))}
              {filteredDir.length === 0 && (
                <div className="py-6 text-center text-sm" style={{ color: wa.sub }}>No people found</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
