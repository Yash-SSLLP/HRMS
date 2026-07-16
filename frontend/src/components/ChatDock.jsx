import { useEffect, useRef, useState } from 'react';
import api from '../api/client';
import AuthImage from './AuthImage';
import { useThemeStore } from '../store/themeStore';
import { useAuthStore } from '../store/authStore';
import { confirmDialog } from './dialogs';

const POLL_MS = 4000;        // conversation-list poll
const MSG_POLL_MS = 2500;    // active-thread poll (cheap now — incremental)

// ---- tiny localStorage cache so the dock paints instantly on open, then
// revalidates over the network (keyed per user so accounts don't leak) ----
const CACHE_PREFIX = 'hrms:chat:';
const cacheKey = (me, name) => `${CACHE_PREFIX}${me?._id || me?.id || 'anon'}:${name}`;
function readCache(key) { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : null; } catch { return null; } }
function writeCache(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* quota — ignore */ } }

// A shared, no-login video room both parties can join by tapping the link.
function makeCallLink(kind, id) {
  const rnd = Math.random().toString(36).slice(2, 8);
  return `https://meet.jit.si/SSLLP-HRMS-${kind}-${id}-${rnd}`;
}

// Turn URLs in a message body into tappable links; call links get a Join affordance.
const URL_RE = /(https?:\/\/[^\s]+)/g;
function renderBody(text) {
  return String(text || '').split(URL_RE).map((part, i) => {
    if (i % 2 === 0) return <span key={i}>{part}</span>;
    const isCall = /meet\.jit\.si|meet\.google\.com/.test(part);
    return (
      <a key={i} href={part} target="_blank" rel="noopener noreferrer"
        style={{ color: isCall ? '#008069' : '#2563eb', textDecoration: 'underline', fontWeight: isCall ? 700 : 400, wordBreak: 'break-all' }}>
        {isCall ? '📹 Join video call' : part}
      </a>
    );
  });
}

// Upgrade my own messages' ticks from "read up to" markers, so the sender sees
// delivered/seen without re-downloading their old messages each poll.
function applyReceipts(msgs, seenUpTo, deliveredUpTo) {
  if (!seenUpTo && !deliveredUpTo) return msgs;
  const seenT = seenUpTo ? new Date(seenUpTo).getTime() : 0;
  const delT = deliveredUpTo ? new Date(deliveredUpTo).getTime() : 0;
  let changed = false;
  const out = msgs.map((m) => {
    if (!m.mine || m.status === 'seen') return m;
    const t = new Date(m.createdAt).getTime();
    if (seenT && t <= seenT) { changed = true; return { ...m, status: 'seen' }; }
    if (delT && t <= delT && m.status === 'sent') { changed = true; return { ...m, status: 'delivered' }; }
    return m;
  });
  return changed ? out : msgs;
}

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

const TICK_SINGLE =
  'M10.91 3.316l-.478-.372a.365.365 0 0 0-.51.063L4.566 9.879a.32.32 0 0 1-.484.033L1.891 7.769a.366.366 0 0 0-.515.006l-.423.433a.364.364 0 0 0 .006.514l3.258 3.185c.143.14.361.125.484-.033l6.272-8.048a.365.365 0 0 0-.063-.51z';
const TICK_DOUBLE =
  'M15.01 3.316l-.478-.372a.365.365 0 0 0-.51.063L8.666 9.879a.32.32 0 0 1-.484.033l-.358-.325a.319.319 0 0 0-.484.032l-.378.483a.418.418 0 0 0 .036.541l1.32 1.266c.143.14.361.125.484-.033l6.272-8.048a.366.366 0 0 0-.063-.51zm-4.1 0l-.478-.372a.365.365 0 0 0-.51.063L4.566 9.879a.32.32 0 0 1-.484.033L1.891 7.769a.366.366 0 0 0-.515.006l-.423.433a.364.364 0 0 0 .006.514l3.258 3.185c.143.14.361.125.484-.033l6.272-8.048a.365.365 0 0 0-.063-.51z';

function MsgTicks({ status, mode }) {
  if (!status) return null;
  const seen = status === 'seen';
  const color = seen ? '#53bdeb' : mode === 'dark' ? '#8696a0' : '#667781';
  return (
    <svg viewBox="0 0 16 15" width="15" height="14"
      style={{ color, display: 'inline-block', verticalAlign: '-2px', marginLeft: 1 }}
      role="img" aria-label={status === 'sent' ? 'Sent' : status === 'delivered' ? 'Delivered' : 'Seen'}>
      <path fill="currentColor" d={status === 'sent' ? TICK_SINGLE : TICK_DOUBLE} />
    </svg>
  );
}

function Avatar({ name, size = 38, group, photoUrl }) {
  const base = (
    <span className="inline-flex items-center justify-center rounded-full font-semibold shrink-0"
      style={{ width: size, height: size, fontSize: size * 0.38, background: group ? '#5b7c9d' : '#6b7c85', color: '#fff' }}>
      {group ? '👥' : initials(name)}
    </span>
  );
  if (!photoUrl) return base;
  return (
    <AuthImage url={photoUrl} alt={name} fallback={base}
      className="rounded-full object-cover shrink-0 bg-gray-200"
      style={{ width: size, height: size }} />
  );
}

// Build the avatar endpoint for a user / group, with a cache-busting suffix so
// the image refreshes after a photo change (the backend ignores the query).
const userPhotoUrl = (id, has, bust) => (has ? `/auth/users/${id}/avatar?b=${bust}` : null);
const groupPhotoUrl = (id, has, bust) => (has ? `/chat/groups/${id}/photo?b=${bust}` : null);

// Floating WhatsApp-style messaging dock with 1:1 + group chats.
export default function ChatDock() {
  const mode = useThemeStore((s) => s.mode);
  const wa = mode === 'dark' ? WA_DARK : WA_LIGHT;
  const me = useAuthStore((s) => s.user);

  const [isMobile, setIsMobile] = useState(false);
  const [bust, setBust] = useState(0); // bump to force avatar/photo re-fetch
  const [open, setOpen] = useState(false);
  const [connections, setConnections] = useState([]);
  const [requests, setRequests] = useState({ incoming: [], outgoing: [] });
  const [groups, setGroups] = useState([]);
  const [groupInvites, setGroupInvites] = useState([]);

  const [showFind, setShowFind] = useState(false);
  const [showGroup, setShowGroup] = useState(false);
  const [directory, setDirectory] = useState([]);
  const [dirSearch, setDirSearch] = useState('');
  const [groupName, setGroupName] = useState('');
  const [groupPick, setGroupPick] = useState([]);

  // active conversation: null | { kind:'direct'|'group', id, name, sub }
  const [active, setActive] = useState(null);
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [menuFor, setMenuFor] = useState(null); // message id whose delete popover is open

  // Group info / settings panel
  const [showInfo, setShowInfo] = useState(false);
  const [info, setInfo] = useState(null); // { groupId, name, hasPhoto, myRole, createdBy, members }
  const [renameVal, setRenameVal] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [showAddMembers, setShowAddMembers] = useState(false);
  const [addPick, setAddPick] = useState([]);

  const activeRef = useRef(null);
  const bottomRef = useRef(null);
  const photoInputRef = useRef(null);
  const cursorRef = useRef(null);       // last message createdAt for incremental polls
  const messagesRef = useRef([]);       // mirror of `messages` for append/dedupe

  const msgsCacheKey = (conv) => cacheKey(me, `msg:${conv.kind}:${conv.id}`);

  const unreadTotal =
    connections.reduce((s, c) => s + (c.unread || 0), 0) +
    groups.reduce((s, g) => s + (g.unread || 0), 0);

  useEffect(() => {
    const update = () => setIsMobile(window.innerWidth <= 639);
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  const loadLists = async () => {
    try {
      const [connRes, reqRes, grpRes] = await Promise.all([
        api.get('/chat/connections'),
        api.get('/chat/requests'),
        api.get('/chat/groups'),
      ]);
      setConnections(connRes.data.connections);
      setRequests(reqRes.data);
      setGroups(grpRes.data.groups);
      setGroupInvites(grpRes.data.invites);
      writeCache(cacheKey(me, 'connections'), connRes.data.connections);
      writeCache(cacheKey(me, 'groups'), grpRes.data.groups);
    } catch { /* stay quiet */ }
  };

  const loadDirectory = async () => {
    try { const { data } = await api.get('/chat/directory'); setDirectory(data.people); }
    catch (err) { setError(err.response?.data?.message || 'Failed to load directory'); }
  };

  // Fetch a thread. The first open does a FULL load (so the whole history is
  // available); every poll after passes ?after=<cursor> and only appends the
  // handful of new messages — tiny payload, no full-history re-download.
  const loadMessages = async (conv, { incremental = false } = {}) => {
    if (!conv) return;
    try {
      const base = conv.kind === 'group' ? `/chat/groups/${conv.id}/messages` : `/chat/messages/${conv.id}`;
      const url = incremental && cursorRef.current
        ? `${base}?after=${encodeURIComponent(cursorRef.current)}`
        : base;
      const { data } = await api.get(url);
      if (!(activeRef.current && activeRef.current.kind === conv.kind && activeRef.current.id === conv.id)) return;

      const prev = messagesRef.current;
      let next;
      if (data.incremental) {
        if (!data.messages.length) next = prev;
        else {
          const seen = new Set(prev.map((m) => m._id));
          const add = data.messages.filter((m) => !seen.has(m._id));
          next = add.length ? [...prev, ...add] : prev;
        }
      } else {
        next = data.messages;
      }
      next = applyReceipts(next, data.seenUpTo, data.deliveredUpTo);
      const last = next[next.length - 1];
      if (last) cursorRef.current = last.createdAt;
      writeCache(msgsCacheKey(conv), next.slice(-50));
      if (next !== prev) setMessages(next);
    } catch (err) { setError(err.response?.data?.message || 'Failed to load messages'); }
  };

  useEffect(() => {
    const cc = readCache(cacheKey(me, 'connections')); if (cc) setConnections(cc);
    const gg = readCache(cacheKey(me, 'groups')); if (gg) setGroups(gg);
    loadLists();
    const t = setInterval(loadLists, POLL_MS);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    activeRef.current = active;
    cursorRef.current = null;
    if (!active) { setMessages([]); return undefined; }
    // Paint cached tail instantly, then do a full load to fill in older history.
    const cached = readCache(msgsCacheKey(active));
    setMessages(cached || []);
    loadMessages(active, { incremental: false });
    const t = setInterval(() => loadMessages(active, { incremental: true }), MSG_POLL_MS);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  useEffect(() => {
    messagesRef.current = messages;
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const openConversation = (conv) => {
    setActive(conv);
    setOpen(true);
    setMenuFor(null);
    if (conv.kind === 'direct') setConnections((p) => p.map((c) => (c.connectionId === conv.id ? { ...c, unread: 0 } : c)));
    else setGroups((p) => p.map((g) => (g.groupId === conv.id ? { ...g, unread: 0 } : g)));
  };

  const openFind = async () => { setShowFind(true); setOpen(true); await loadDirectory(); };
  const openGroupCreate = async () => { setShowGroup(true); setOpen(true); setGroupName(''); setGroupPick([]); await loadDirectory(); };

  const sendRequest = async (recipientId) => {
    setError('');
    try { await api.post('/chat/requests', { recipientId }); await Promise.all([loadDirectory(), loadLists()]); }
    catch (err) { setError(err.response?.data?.message || 'Could not send request'); }
  };

  const respond = async (id, action) => {
    setError('');
    try { await api.patch(`/chat/requests/${id}`, { action }); await loadLists(); if (showFind) await loadDirectory(); }
    catch (err) { setError(err.response?.data?.message || 'Could not respond'); }
  };

  const respondGroup = async (groupId, action) => {
    setError('');
    try { await api.patch(`/chat/groups/${groupId}/respond`, { action }); await loadLists(); }
    catch (err) { setError(err.response?.data?.message || 'Could not respond'); }
  };

  const createGroup = async () => {
    setError('');
    if (!groupName.trim()) { setError('Group name is required'); return; }
    if (groupPick.length === 0) { setError('Pick at least one person to invite'); return; }
    try {
      await api.post('/chat/groups', { name: groupName.trim(), memberIds: groupPick });
      setShowGroup(false);
      await loadLists();
    } catch (err) { setError(err.response?.data?.message || 'Could not create group'); }
  };

  // Append a just-sent message locally and keep the incremental cursor in step.
  const appendSent = (msg) => {
    const next = [...messagesRef.current, msg];
    cursorRef.current = msg.createdAt;
    setMessages(next);
    if (active) writeCache(msgsCacheKey(active), next.slice(-50));
  };

  const send = async (e) => {
    e.preventDefault();
    if (!draft.trim() || !active || active.resigned) return;
    setSending(true); setError('');
    try {
      const body = draft;
      const { data } = active.kind === 'group'
        ? await api.post(`/chat/groups/${active.id}/messages`, { body })
        : await api.post('/chat/messages', { connectionId: active.id, body });
      appendSent(data.message);
      setDraft('');
      loadLists();
    } catch (err) { setError(err.response?.data?.message || 'Could not send message'); }
    finally { setSending(false); }
  };

  // Start a video call: post a joinable room link into the chat and open it.
  const startCall = async () => {
    if (!active || active.resigned) return;
    const link = makeCallLink(active.kind, active.id);
    const body = `📹 Video call — tap to join: ${link}`;
    try {
      const { data } = active.kind === 'group'
        ? await api.post(`/chat/groups/${active.id}/messages`, { body })
        : await api.post('/chat/messages', { connectionId: active.id, body });
      appendSent(data.message);
      loadLists();
      window.open(link, '_blank', 'noopener,noreferrer');
    } catch (err) { setError(err.response?.data?.message || 'Could not start the call'); }
  };

  const deleteMessage = async (id) => {
    setMenuFor(null);
    setMessages((prev) => prev.filter((m) => m._id !== id));
    try { await api.delete(`/chat/messages/${id}`); loadLists(); }
    catch (err) { setError(err.response?.data?.message || 'Could not delete'); loadMessages(active); }
  };

  const clearChat = async () => {
    if (!active) return;
    if (!(await confirmDialog({ message: 'Clear this chat from your view? It cannot be undone for you.' }))) return;
    const url = active.kind === 'group' ? `/chat/groups/${active.id}/messages` : `/chat/conversations/${active.id}`;
    try { await api.delete(url); setMessages([]); setActive(null); loadLists(); }
    catch (err) { setError(err.response?.data?.message || 'Could not clear chat'); }
  };

  // ----- Group info / settings -----
  const loadInfo = async (groupId) => {
    try { const { data } = await api.get(`/chat/groups/${groupId}`); setInfo(data); setRenameVal(data.name); }
    catch (err) { setError(err.response?.data?.message || 'Failed to load group info'); }
  };

  const openGroupInfo = async () => {
    if (!active || active.kind !== 'group') return;
    setShowInfo(true); setShowAddMembers(false); setError('');
    await loadInfo(active.id);
  };

  const saveRename = async () => {
    if (!info || !renameVal.trim() || renameVal.trim() === info.name) return;
    setRenaming(true); setError('');
    try {
      const { data } = await api.patch(`/chat/groups/${info.groupId}`, { name: renameVal.trim() });
      setInfo((i) => ({ ...i, name: data.name }));
      setActive((a) => (a && a.kind === 'group' && a.id === info.groupId ? { ...a, name: data.name } : a));
      loadLists();
    } catch (err) { setError(err.response?.data?.message || 'Could not rename group'); }
    finally { setRenaming(false); }
  };

  const onPickPhoto = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-selecting the same file
    if (!file || !info) return;
    setError('');
    const form = new FormData();
    form.append('photo', file);
    try {
      await api.post(`/chat/groups/${info.groupId}/photo`, form);
      const next = bust + 1; setBust(next);
      setInfo((i) => ({ ...i, hasPhoto: true }));
      setActive((a) => (a && a.kind === 'group' && a.id === info.groupId ? { ...a, photoUrl: groupPhotoUrl(info.groupId, true, next) } : a));
      loadLists();
    } catch (err) { setError(err.response?.data?.message || 'Could not update photo'); }
  };

  const removeGroupPhoto = async () => {
    if (!info) return;
    setError('');
    try {
      await api.delete(`/chat/groups/${info.groupId}/photo`);
      setBust((b) => b + 1);
      setInfo((i) => ({ ...i, hasPhoto: false }));
      setActive((a) => (a && a.kind === 'group' && a.id === info.groupId ? { ...a, photoUrl: null } : a));
      loadLists();
    } catch (err) { setError(err.response?.data?.message || 'Could not remove photo'); }
  };

  const removeMember = async (userId) => {
    if (!info) return;
    setError('');
    try { await api.delete(`/chat/groups/${info.groupId}/members/${userId}`); await loadInfo(info.groupId); loadLists(); }
    catch (err) { setError(err.response?.data?.message || 'Could not remove member'); }
  };

  const setRole = async (userId, role) => {
    if (!info) return;
    setError('');
    try { await api.patch(`/chat/groups/${info.groupId}/members/${userId}`, { role }); await loadInfo(info.groupId); }
    catch (err) { setError(err.response?.data?.message || 'Could not change role'); }
  };

  const openAddMembers = async () => { setShowAddMembers(true); setAddPick([]); setDirSearch(''); await loadDirectory(); };

  const submitAddMembers = async () => {
    if (!info || addPick.length === 0) { setShowAddMembers(false); return; }
    setError('');
    try {
      await api.post(`/chat/groups/${info.groupId}/members`, { memberIds: addPick });
      setShowAddMembers(false);
      await loadInfo(info.groupId); loadLists();
    } catch (err) { setError(err.response?.data?.message || 'Could not add members'); }
  };

  // Leave a group and remove it from my chats. Works from the chat header or
  // the group-info panel.
  const leaveGroup = async (groupId = info?.groupId) => {
    if (!groupId) return;
    if (!(await confirmDialog({ message: 'Delete this group from your chats? You will leave the group and it will be removed for you.', tone: 'danger', confirmText: 'Delete' }))) return;
    setError('');
    try {
      await api.post(`/chat/groups/${groupId}/leave`);
      setShowInfo(false); setInfo(null); setActive(null);
      loadLists();
    } catch (err) { setError(err.response?.data?.message || 'Could not delete group'); }
  };

  const togglePick = (id) => setGroupPick((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const toggleAddPick = (id) => setAddPick((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  const filteredDir = directory.filter((p) =>
    p.fullName.toLowerCase().includes(dirSearch.toLowerCase()) ||
    (p.email || '').toLowerCase().includes(dirSearch.toLowerCase()));

  const fmtTime = (d) => new Date(d).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true });

  // --- Phone, collapsed: a circular floating button ---
  if (isMobile && !open && !showFind && !showGroup) {
    return (
      <button onClick={() => setOpen(true)} aria-label="Open chats"
        className="fixed bottom-5 right-5 z-40 w-14 h-14 rounded-full shadow-xl flex items-center justify-center print:hidden"
        style={{ background: '#008069' }}>
        <svg width="26" height="26" viewBox="0 0 24 24" fill="#fff">
          <path d="M12 2a10 10 0 00-8.94 14.47L2 22l5.7-1.5A10 10 0 1012 2zm0 18a8 8 0 01-4.1-1.13l-.29-.17-3.39.89.9-3.3-.19-.3A8 8 0 1112 20z" />
        </svg>
        {unreadTotal > 0 && (
          <span className="chat-badge absolute -top-0.5 -right-0.5 text-[10px] rounded-full min-w-[20px] h-5 px-1 flex items-center justify-center font-bold"
            style={{ background: wa.badge, color: '#0b141a', border: '2px solid #fff' }}>
            {unreadTotal > 9 ? '9+' : unreadTotal}
          </span>
        )}
      </button>
    );
  }

  const windowClass = isMobile ? 'absolute inset-0 flex flex-col' : 'w-80 max-w-[92vw] rounded-t-xl shadow-2xl flex flex-col overflow-hidden';
  const windowStyle = isMobile ? { background: wa.chatBg } : { height: '28rem', background: wa.chatBg, border: `1px solid ${wa.border}` };
  const panelClass = isMobile ? 'absolute inset-0 flex flex-col' : 'w-80 max-w-[92vw] rounded-t-xl shadow-2xl overflow-hidden';

  return (
    <div className={isMobile ? 'fixed inset-0 z-50 print:hidden' : 'fixed bottom-0 right-4 z-40 flex items-end gap-3 print:hidden'}>
      {/* Open conversation window */}
      {active && open && (
        <div className={windowClass} style={windowStyle}>
          {/* Header */}
          <div className="flex items-center gap-2 px-3 py-2" style={{ background: wa.header }}>
            <button onClick={() => setActive(null)} className="text-2xl leading-none px-1" style={{ color: wa.headerText }} aria-label="Back">
              {isMobile ? '‹' : '×'}
            </button>
            <button
              onClick={() => active.kind === 'group' && openGroupInfo()}
              className={`flex items-center gap-2 min-w-0 flex-1 text-left ${active.kind === 'group' ? 'cursor-pointer' : 'cursor-default'}`}
              title={active.kind === 'group' ? 'Group info' : undefined}>
              <Avatar name={active.name} size={36} group={active.kind === 'group'} photoUrl={active.photoUrl} />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold truncate flex items-center gap-1.5" style={{ color: wa.headerText }}>
                  {active.name}
                  {active.resigned && (
                    <span className="text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full shrink-0"
                      style={{ background: 'rgba(255,255,255,.22)', color: wa.headerText }}>Resigned</span>
                  )}
                </div>
                <div className="text-[11px] truncate" style={{ color: mode === 'dark' ? '#8696a0' : 'rgba(255,255,255,.8)' }}>
                  {active.resigned ? 'Left the organization' : active.sub}{active.kind === 'group' ? ' · tap for info' : ''}
                </div>
              </div>
            </button>
            {!active.resigned && (
              <button onClick={startCall} title="Start video call" className="px-1.5" style={{ color: wa.headerText }} aria-label="Start video call">
                <svg width="19" height="19" viewBox="0 0 24 24" fill="currentColor"><path d="M17 10.5V7a1 1 0 00-1-1H4a1 1 0 00-1 1v10a1 1 0 001 1h12a1 1 0 001-1v-3.5l4 4v-11l-4 4z" /></svg>
              </button>
            )}
            <button onClick={clearChat} title="Clear chat" className="px-1.5" style={{ color: wa.headerText }} aria-label="Clear chat">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M6 7h12v2H6V7zm1 3h10l-1 11H8L7 10zm3-6h4l1 1h3v2H3V5h3l1-1z" /></svg>
            </button>
            {active.kind === 'group' && (
              <button onClick={() => leaveGroup(active.id)} title="Delete group for me" className="px-1.5" style={{ color: wa.headerText }} aria-label="Delete group">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M10 17v-2H3V9h7V7l5 5-5 5zm9 4H12v-2h7V5h-7V3h7a2 2 0 012 2v14a2 2 0 01-2 2z" /></svg>
              </button>
            )}
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-3 py-3 space-y-1.5" style={{ backgroundImage: CHAT_PATTERN, backgroundColor: wa.chatBg }}
            onClick={() => menuFor && setMenuFor(null)}>
            {messages.map((m) => (
              <div key={m._id} className={`group flex items-center gap-1 ${m.mine ? 'justify-end' : 'justify-start'}`}>
                {m.mine && (
                  <button onClick={(e) => { e.stopPropagation(); setMenuFor(menuFor === m._id ? null : m._id); }}
                    className="opacity-40 hover:opacity-100 text-xs shrink-0" style={{ color: wa.sub }} aria-label="Message options">⋮</button>
                )}
                <div className="max-w-[78%] px-2.5 py-1.5 text-sm shadow-sm relative"
                  style={{
                    background: m.mine ? wa.bubbleOut : wa.bubbleIn,
                    color: m.mine ? (mode === 'dark' ? wa.text : '#111b21') : wa.text,
                    borderRadius: m.mine ? '8px 8px 2px 8px' : '8px 8px 8px 2px',
                  }}>
                  {!m.mine && active.kind === 'group' && (
                    <div className="text-[11px] font-semibold mb-0.5" style={{ color: '#53bdeb' }}>{m.senderName}</div>
                  )}
                  <span className="break-words whitespace-pre-wrap">{renderBody(m.body)}</span>
                  <span className="text-[10px] ml-2 align-bottom inline-flex items-center" style={{ color: wa.sub }}>
                    {fmtTime(m.createdAt)}
                    {m.mine && active.kind === 'direct' && <MsgTicks status={m.status} mode={mode} />}
                  </span>
                  {menuFor === m._id && (
                    <button onClick={(e) => { e.stopPropagation(); deleteMessage(m._id); }}
                      className="absolute z-10 -top-7 right-0 text-[11px] px-2 py-1 rounded shadow"
                      style={{ background: wa.panel, color: '#dc2626', border: `1px solid ${wa.border}` }}>Delete for me</button>
                  )}
                </div>
                {!m.mine && (
                  <button onClick={(e) => { e.stopPropagation(); setMenuFor(menuFor === m._id ? null : m._id); }}
                    className="opacity-40 hover:opacity-100 text-xs shrink-0" style={{ color: wa.sub }} aria-label="Message options">⋮</button>
                )}
              </div>
            ))}
            <div ref={bottomRef} />
          </div>

          {/* Composer — blocked when the other person has left the organization */}
          {active.resigned ? (
            <div className="p-3 text-center text-xs" style={{ background: wa.composerBg, color: wa.sub }}>
              This person has resigned and left the organization. You can no longer send them messages.
            </div>
          ) : (
            <form onSubmit={send} className="flex items-center gap-2 p-2" style={{ background: wa.composerBg }}>
              <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Type a message"
                className="flex-1 rounded-full px-4 py-2 text-sm outline-none"
                style={{ background: wa.inputBg, color: wa.text, border: `1px solid ${wa.border}` }} />
              <button type="submit" disabled={sending || !draft.trim()}
                className="w-10 h-10 rounded-full flex items-center justify-center shrink-0 disabled:opacity-50"
                style={{ background: '#008069', color: '#fff' }} aria-label="Send">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" /></svg>
              </button>
            </form>
          )}
        </div>
      )}

      {/* Messaging panel */}
      {(!isMobile || !active) && (
        <div className={panelClass} style={{ background: wa.panel, border: isMobile ? 'none' : `1px solid ${wa.border}` }}>
          <div className="flex items-center gap-2 px-3 py-2.5" style={{ background: wa.header }}>
            <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-2 flex-1 min-w-0 text-left">
              <span className="w-8 h-8 rounded-full flex items-center justify-center" style={{ background: 'rgba(255,255,255,.18)' }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill={wa.headerText}><path d="M12 2a10 10 0 00-8.94 14.47L2 22l5.7-1.5A10 10 0 1012 2zm0 18a8 8 0 01-4.1-1.13l-.29-.17-3.39.89.9-3.3-.19-.3A8 8 0 1112 20z"/></svg>
              </span>
              <span className="text-sm font-semibold" style={{ color: wa.headerText }}>Chats</span>
              {unreadTotal > 0 && (
                <span className="chat-badge text-[10px] rounded-full min-w-[18px] h-[18px] px-1.5 flex items-center justify-center leading-none font-bold" style={{ background: wa.badge, color: '#0b141a' }}>
                  {unreadTotal > 9 ? '9+' : unreadTotal}
                </span>
              )}
            </button>
            <button onClick={openGroupCreate} title="New group"
              className="w-8 h-8 rounded-full flex items-center justify-center hover:opacity-90" style={{ background: 'rgba(255,255,255,.18)', color: wa.headerText }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5s-3 1.34-3 3 1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>
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
              {error && <div className="mx-3 mt-2 text-xs text-red-700 bg-red-50 border border-red-200 px-2 py-1 rounded">{error}</div>}

              <div className="flex-1 overflow-y-auto">
                {/* Pending invites (connection + group) */}
                {(requests.incoming.length > 0 || groupInvites.length > 0) && (
                  <div className="p-3" style={{ borderBottom: `1px solid ${wa.border}`, background: mode === 'dark' ? '#182229' : '#fff8e6' }}>
                    <div className="text-[11px] font-semibold mb-2" style={{ color: wa.sub }}>
                      Requests &amp; invites ({requests.incoming.length + groupInvites.length})
                    </div>
                    <div className="space-y-2">
                      {requests.incoming.map((r) => (
                        <div key={r._id} className="flex items-center gap-2">
                          <Avatar name={r.from.fullName} size={30} photoUrl={userPhotoUrl(r.from._id, r.from.hasPhoto, bust)} />
                          <span className="text-xs truncate flex-1" style={{ color: wa.text }}>{r.from.fullName}</span>
                          <span className="flex gap-1 shrink-0">
                            <button onClick={() => respond(r._id, 'accept')} className="text-[11px] px-2.5 py-1 rounded-full text-white" style={{ background: '#008069' }}>Accept</button>
                            <button onClick={() => respond(r._id, 'decline')} className="text-[11px] px-2.5 py-1 rounded-full" style={{ border: `1px solid ${wa.border}`, color: wa.sub }}>Decline</button>
                          </span>
                        </div>
                      ))}
                      {groupInvites.map((g) => (
                        <div key={g.groupId} className="flex items-center gap-2">
                          <Avatar name={g.name} size={30} group photoUrl={groupPhotoUrl(g.groupId, g.hasPhoto, bust)} />
                          <span className="text-xs truncate flex-1" style={{ color: wa.text }}>
                            {g.name} <span style={{ color: wa.sub }}>· group from {g.from?.fullName || 'someone'}</span>
                          </span>
                          <span className="flex gap-1 shrink-0">
                            <button onClick={() => respondGroup(g.groupId, 'accept')} className="text-[11px] px-2.5 py-1 rounded-full text-white" style={{ background: '#008069' }}>Accept</button>
                            <button onClick={() => respondGroup(g.groupId, 'decline')} className="text-[11px] px-2.5 py-1 rounded-full" style={{ border: `1px solid ${wa.border}`, color: wa.sub }}>Decline</button>
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {connections.length === 0 && groups.length === 0 ? (
                  <div className="p-6 text-center text-xs" style={{ color: wa.sub }}>
                    No chats yet. Use the icons above to start a chat or create a group.
                  </div>
                ) : (
                  <>
                    {/* Groups */}
                    {groups.map((g) => {
                      const isActive = active?.kind === 'group' && active.id === g.groupId;
                      return (
                        <button key={`g-${g.groupId}`}
                          onClick={() => openConversation({ kind: 'group', id: g.groupId, name: g.name, sub: `${g.memberCount} members`, photoUrl: groupPhotoUrl(g.groupId, g.hasPhoto, bust) })}
                          className="w-full text-left px-3 py-2.5 flex items-center gap-3 transition-colors"
                          style={{ borderBottom: `1px solid ${wa.border}`, background: isActive ? wa.listHover : 'transparent' }}
                          onMouseEnter={(e) => { e.currentTarget.style.background = wa.listHover; }}
                          onMouseLeave={(e) => { e.currentTarget.style.background = isActive ? wa.listHover : 'transparent'; }}>
                          <Avatar name={g.name} size={42} group photoUrl={groupPhotoUrl(g.groupId, g.hasPhoto, bust)} />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-sm truncate font-medium" style={{ color: wa.text }}>{g.name}</span>
                              {g.lastMessage && <span className="text-[10px] shrink-0" style={{ color: g.unread > 0 ? wa.badge : wa.sub }}>{fmtTime(g.lastMessage.createdAt)}</span>}
                            </div>
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-[12px] truncate" style={{ color: wa.sub }}>
                                {g.lastMessage ? `${g.lastMessage.mine ? 'You: ' : ''}${g.lastMessage.body}` : `${g.memberCount} members`}
                              </span>
                              {g.unread > 0 && <span className="text-[10px] rounded-full min-w-[18px] h-[18px] px-1 flex items-center justify-center font-bold shrink-0" style={{ background: wa.badge, color: '#0b141a' }}>{g.unread}</span>}
                            </div>
                          </div>
                        </button>
                      );
                    })}

                    {/* 1:1 connections */}
                    {connections.map((c) => {
                      const isActive = active?.kind === 'direct' && active.id === c.connectionId;
                      return (
                        <button key={`c-${c.connectionId}`}
                          onClick={() => openConversation({ kind: 'direct', id: c.connectionId, name: c.person.fullName, sub: c.person.role, resigned: c.person.resigned, photoUrl: userPhotoUrl(c.person._id, c.person.hasPhoto, bust) })}
                          className="w-full text-left px-3 py-2.5 flex items-center gap-3 transition-colors"
                          style={{ borderBottom: `1px solid ${wa.border}`, background: isActive ? wa.listHover : 'transparent' }}
                          onMouseEnter={(e) => { e.currentTarget.style.background = wa.listHover; }}
                          onMouseLeave={(e) => { e.currentTarget.style.background = isActive ? wa.listHover : 'transparent'; }}>
                          <Avatar name={c.person.fullName} size={42} photoUrl={userPhotoUrl(c.person._id, c.person.hasPhoto, bust)} />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-sm truncate font-medium flex items-center gap-1.5" style={{ color: wa.text }}>
                                {c.person.fullName}
                                {c.person.resigned && (
                                  <span className="text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full shrink-0"
                                    style={{ background: mode === 'dark' ? '#3a2a2a' : '#fde8e8', color: '#c0392b' }}>Resigned</span>
                                )}
                              </span>
                              {c.lastMessage && <span className="text-[10px] shrink-0" style={{ color: c.unread > 0 ? wa.badge : wa.sub }}>{fmtTime(c.lastMessage.createdAt)}</span>}
                            </div>
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-[12px] truncate" style={{ color: wa.sub }}>
                                {c.person.resigned ? 'Left the organization' : (c.lastMessage ? `${c.lastMessage.mine ? 'You: ' : ''}${c.lastMessage.body}` : c.person.role)}
                              </span>
                              {c.unread > 0 && <span className="text-[10px] rounded-full min-w-[18px] h-[18px] px-1 flex items-center justify-center font-bold shrink-0" style={{ background: wa.badge, color: '#0b141a' }}>{c.unread}</span>}
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </>
                )}
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
            <input value={dirSearch} onChange={(e) => setDirSearch(e.target.value)} placeholder="Search by name or email…"
              className="w-full rounded-full px-4 py-2 text-sm mb-3 outline-none" style={{ background: wa.inputBg, color: wa.text, border: `1px solid ${wa.border}` }} />
            <div className="max-h-80 overflow-y-auto">
              {filteredDir.map((p) => (
                <div key={p._id} className="flex items-center gap-3 py-2" style={{ borderBottom: `1px solid ${wa.border}` }}>
                  <Avatar name={p.fullName} size={38} photoUrl={userPhotoUrl(p._id, p.hasPhoto, bust)} />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium truncate" style={{ color: wa.text }}>{p.fullName}</div>
                    <div className="text-xs truncate" style={{ color: wa.sub }}>{p.role} · {p.email}</div>
                  </div>
                  {p.connectionStatus === 'none' && <button onClick={() => sendRequest(p._id)} className="text-xs px-3 py-1.5 rounded-full text-white shrink-0" style={{ background: '#008069' }}>Connect</button>}
                  {p.connectionStatus === 'pending-out' && <span className="text-xs shrink-0" style={{ color: wa.sub }}>Requested</span>}
                  {p.connectionStatus === 'pending-in' && <button onClick={() => respond(p.connectionId, 'accept')} className="text-xs px-3 py-1.5 rounded-full text-white shrink-0" style={{ background: '#008069' }}>Accept</button>}
                  {p.connectionStatus === 'accepted' && <span className="text-xs shrink-0" style={{ color: '#25d366' }}>✓ Chatting</span>}
                </div>
              ))}
              {filteredDir.length === 0 && <div className="py-6 text-center text-sm" style={{ color: wa.sub }}>No people found</div>}
            </div>
          </div>
        </div>
      )}

      {/* Create group modal */}
      {showGroup && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50">
          <div className="rounded-xl shadow-lg w-full max-w-lg p-6" style={{ background: wa.panel }}>
            <div className="flex items-start justify-between mb-4">
              <h2 className="text-lg font-semibold" style={{ color: wa.text }}>New group</h2>
              <button onClick={() => setShowGroup(false)} className="text-xl leading-none" style={{ color: wa.sub }}>×</button>
            </div>
            <input value={groupName} onChange={(e) => setGroupName(e.target.value)} placeholder="Group name"
              className="w-full rounded-lg px-4 py-2 text-sm mb-2 outline-none" style={{ background: wa.inputBg, color: wa.text, border: `1px solid ${wa.border}` }} />
            <input value={dirSearch} onChange={(e) => setDirSearch(e.target.value)} placeholder="Search people to invite…"
              className="w-full rounded-full px-4 py-2 text-sm mb-2 outline-none" style={{ background: wa.inputBg, color: wa.text, border: `1px solid ${wa.border}` }} />
            <div className="text-[11px] mb-2" style={{ color: wa.sub }}>{groupPick.length} selected · invitees must accept to join</div>
            {error && <div className="text-xs text-red-700 bg-red-50 border border-red-200 px-2 py-1 rounded mb-2">{error}</div>}
            <div className="max-h-72 overflow-y-auto mb-3">
              {filteredDir.map((p) => (
                <label key={p._id} className="flex items-center gap-3 py-2 cursor-pointer" style={{ borderBottom: `1px solid ${wa.border}` }}>
                  <input type="checkbox" checked={groupPick.includes(p._id)} onChange={() => togglePick(p._id)} />
                  <Avatar name={p.fullName} size={34} photoUrl={userPhotoUrl(p._id, p.hasPhoto, bust)} />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium truncate" style={{ color: wa.text }}>{p.fullName}</div>
                    <div className="text-xs truncate" style={{ color: wa.sub }}>{p.role}</div>
                  </div>
                </label>
              ))}
              {filteredDir.length === 0 && <div className="py-6 text-center text-sm" style={{ color: wa.sub }}>No people found</div>}
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setShowGroup(false)} className="px-4 py-2 text-sm rounded-lg" style={{ border: `1px solid ${wa.border}`, color: wa.sub }}>Cancel</button>
              <button onClick={createGroup} className="px-4 py-2 text-sm rounded-lg text-white" style={{ background: '#008069' }}>Create group</button>
            </div>
          </div>
        </div>
      )}

      {/* Group info / settings panel */}
      {showInfo && info && (() => {
        const canManage = info.myRole === 'owner' || info.myRole === 'admin';
        const isOwner = info.myRole === 'owner';
        const photoUrl = groupPhotoUrl(info.groupId, info.hasPhoto, bust);
        return (
          <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-[55]">
            <div className="rounded-xl shadow-lg w-full max-w-lg flex flex-col max-h-[88vh]" style={{ background: wa.panel }}>
              {/* Header */}
              <div className="flex items-center justify-between px-5 py-3" style={{ borderBottom: `1px solid ${wa.border}` }}>
                <h2 className="text-lg font-semibold" style={{ color: wa.text }}>Group info</h2>
                <button onClick={() => { setShowInfo(false); setShowAddMembers(false); }} className="text-xl leading-none" style={{ color: wa.sub }}>×</button>
              </div>

              <div className="overflow-y-auto p-5">
                {error && <div className="text-xs text-red-700 bg-red-50 border border-red-200 px-2 py-1 rounded mb-3">{error}</div>}

                {/* Photo + name */}
                <div className="flex flex-col items-center text-center mb-5">
                  <div className="relative">
                    <Avatar name={info.name} size={96} group photoUrl={photoUrl} />
                    {canManage && (
                      <button onClick={() => photoInputRef.current?.click()} title="Change photo"
                        className="absolute -bottom-1 -right-1 w-8 h-8 rounded-full flex items-center justify-center shadow text-white" style={{ background: '#008069' }}>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 15.2A3.2 3.2 0 1012 8.8a3.2 3.2 0 000 6.4zM9 2l-1.8 2H4a2 2 0 00-2 2v12a2 2 0 002 2h16a2 2 0 002-2V6a2 2 0 00-2-2h-3.2L15 2H9zm3 16a5 5 0 110-10 5 5 0 010 10z"/></svg>
                      </button>
                    )}
                    <input ref={photoInputRef} type="file" accept="image/*" className="hidden" onChange={onPickPhoto} />
                  </div>
                  {canManage && info.hasPhoto && (
                    <button onClick={removeGroupPhoto} className="text-[11px] mt-2" style={{ color: '#dc2626' }}>Remove photo</button>
                  )}

                  <div className="mt-3 w-full max-w-xs">
                    {canManage ? (
                      <div className="flex items-center gap-2">
                        <input value={renameVal} onChange={(e) => setRenameVal(e.target.value)} maxLength={80}
                          className="flex-1 rounded-lg px-3 py-2 text-sm text-center outline-none"
                          style={{ background: wa.inputBg, color: wa.text, border: `1px solid ${wa.border}` }} />
                        <button onClick={saveRename} disabled={renaming || !renameVal.trim() || renameVal.trim() === info.name}
                          className="text-xs px-3 py-2 rounded-lg text-white disabled:opacity-50" style={{ background: '#008069' }}>Save</button>
                      </div>
                    ) : (
                      <div className="text-base font-semibold" style={{ color: wa.text }}>{info.name}</div>
                    )}
                  </div>
                </div>

                {/* Members */}
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[11px] font-semibold" style={{ color: wa.sub }}>
                    {info.members.filter((m) => m.status === 'accepted').length} members
                  </span>
                  {canManage && (
                    <button onClick={openAddMembers} className="text-xs px-3 py-1.5 rounded-full text-white" style={{ background: '#008069' }}>+ Add members</button>
                  )}
                </div>
                <div className="space-y-1">
                  {info.members.map((m) => {
                    const isMe = String(m._id) === String(me?._id);
                    const canRemove = canManage && !isMe && m.role !== 'owner' && (isOwner || m.role !== 'admin');
                    const canToggleRole = isOwner && !isMe && m.role !== 'owner' && m.status === 'accepted';
                    return (
                      <div key={m._id} className="flex items-center gap-3 py-1.5">
                        <Avatar name={m.fullName} size={36} photoUrl={userPhotoUrl(m._id, m.hasPhoto, bust)} />
                        <div className="min-w-0 flex-1">
                          <div className="text-sm truncate" style={{ color: wa.text }}>
                            {m.fullName}{isMe ? ' (You)' : ''}
                            {m.status === 'invited' && <span className="text-[11px] ml-1" style={{ color: wa.sub }}>· invited</span>}
                          </div>
                          <div className="text-[11px] truncate" style={{ color: wa.sub }}>{m.email}</div>
                        </div>
                        {(m.role === 'owner' || m.role === 'admin') && (
                          <span className="text-[10px] px-2 py-0.5 rounded-full shrink-0"
                            style={{ background: m.role === 'owner' ? '#fde68a' : '#bfdbfe', color: '#1f2937' }}>
                            {m.role === 'owner' ? 'Owner' : 'Admin'}
                          </span>
                        )}
                        {canToggleRole && (
                          <button onClick={() => setRole(m._id, m.role === 'admin' ? 'member' : 'admin')}
                            className="text-[11px] px-2 py-1 rounded shrink-0" style={{ border: `1px solid ${wa.border}`, color: wa.sub }}>
                            {m.role === 'admin' ? 'Remove admin' : 'Make admin'}
                          </button>
                        )}
                        {canRemove && (
                          <button onClick={() => removeMember(m._id)} title="Remove" className="text-sm px-1.5 shrink-0" style={{ color: '#dc2626' }}>✕</button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Footer */}
              <div className="px-5 py-3" style={{ borderTop: `1px solid ${wa.border}` }}>
                <button onClick={() => leaveGroup(info.groupId)} className="w-full text-sm px-4 py-2 rounded-lg font-medium" style={{ background: '#fee2e2', color: '#b91c1c' }}>
                  Leave &amp; delete group for me
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Add members modal */}
      {showAddMembers && info && (() => {
        const existing = new Set(info.members.filter((m) => m.status !== 'declined').map((m) => String(m._id)));
        const addable = filteredDir.filter((p) => !existing.has(String(p._id)));
        return (
          <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-[60]">
            <div className="rounded-xl shadow-lg w-full max-w-lg p-6" style={{ background: wa.panel }}>
              <div className="flex items-start justify-between mb-4">
                <h2 className="text-lg font-semibold" style={{ color: wa.text }}>Add members</h2>
                <button onClick={() => setShowAddMembers(false)} className="text-xl leading-none" style={{ color: wa.sub }}>×</button>
              </div>
              <input value={dirSearch} onChange={(e) => setDirSearch(e.target.value)} placeholder="Search people to add…"
                className="w-full rounded-full px-4 py-2 text-sm mb-2 outline-none" style={{ background: wa.inputBg, color: wa.text, border: `1px solid ${wa.border}` }} />
              <div className="text-[11px] mb-2" style={{ color: wa.sub }}>{addPick.length} selected · they must accept to join</div>
              <div className="max-h-72 overflow-y-auto mb-3">
                {addable.map((p) => (
                  <label key={p._id} className="flex items-center gap-3 py-2 cursor-pointer" style={{ borderBottom: `1px solid ${wa.border}` }}>
                    <input type="checkbox" checked={addPick.includes(p._id)} onChange={() => toggleAddPick(p._id)} />
                    <Avatar name={p.fullName} size={34} photoUrl={userPhotoUrl(p._id, p.hasPhoto, bust)} />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium truncate" style={{ color: wa.text }}>{p.fullName}</div>
                      <div className="text-xs truncate" style={{ color: wa.sub }}>{p.role}</div>
                    </div>
                  </label>
                ))}
                {addable.length === 0 && <div className="py-6 text-center text-sm" style={{ color: wa.sub }}>No one left to add</div>}
              </div>
              <div className="flex justify-end gap-2">
                <button onClick={() => setShowAddMembers(false)} className="px-4 py-2 text-sm rounded-lg" style={{ border: `1px solid ${wa.border}`, color: wa.sub }}>Cancel</button>
                <button onClick={submitAddMembers} className="px-4 py-2 text-sm rounded-lg text-white" style={{ background: '#008069' }}>Add</button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
