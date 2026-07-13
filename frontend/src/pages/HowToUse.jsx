import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { toast } from 'react-toastify';
import api from '../api/client';
import { useAuthStore } from '../store/authStore';
import { hasPermission } from '../config/permissions';
import { confirmDialog } from '../components/dialogs';
import PageHeader from '../components/PageHeader';
import { employeeGuide, hrGuide } from '../content/guides';

// The apps ship a bundled default guide; HR can override it (saved server-side).
const DEFAULTS = { employee: employeeGuide, hr: hrGuide };

// --- Minimal, dependency-free Markdown renderer ---------------------------
// Handles only what the guides use: #/##/###/#### headings, **bold**, *italic*,
// "- " bullets, "1." numbered lists, "---" rules, and plain paragraphs.

function renderInline(text) {
  const nodes = [];
  let rest = text;
  let key = 0;
  const re = /(\*\*([^*]+)\*\*|\*([^*]+)\*)/;
  while (rest) {
    const m = rest.match(re);
    if (!m) { nodes.push(rest); break; }
    if (m.index > 0) nodes.push(rest.slice(0, m.index));
    if (m[2] != null) nodes.push(<strong key={key++}>{m[2]}</strong>);
    else nodes.push(<em key={key++}>{m[3]}</em>);
    rest = rest.slice(m.index + m[0].length);
  }
  return nodes;
}

function MarkdownView({ md }) {
  const blocks = useMemo(() => {
    const lines = (md || '').split('\n');
    const out = [];
    let list = null;
    let k = 0;
    const flush = () => {
      if (!list) return;
      const items = list.items.map((t, i) => <li key={i} className="mb-1">{renderInline(t)}</li>);
      out.push(list.type === 'ol'
        ? <ol key={`b${k++}`} className="list-decimal pl-6 mb-3 text-gray-700 leading-relaxed">{items}</ol>
        : <ul key={`b${k++}`} className="list-disc pl-6 mb-3 text-gray-700 leading-relaxed">{items}</ul>);
      list = null;
    };
    for (const raw of lines) {
      const line = raw.replace(/\s+$/, '');
      if (!line.trim()) { flush(); continue; }
      if (/^#{1,4}\s+/.test(line)) {
        flush();
        const level = line.match(/^(#{1,4})/)[1].length;
        const text = line.replace(/^#{1,4}\s+/, '');
        const cls = {
          1: 'text-2xl font-bold text-gray-900 mt-2 mb-3',
          2: 'text-xl font-bold text-gray-900 mt-6 mb-2 pb-1 border-b border-gray-100',
          3: 'text-base font-semibold text-gray-900 mt-4 mb-1.5',
          4: 'text-sm font-semibold text-gray-700 mt-3 mb-1',
        }[level];
        const Tag = `h${level}`;
        out.push(<Tag key={`b${k++}`} className={cls}>{renderInline(text)}</Tag>);
        continue;
      }
      if (/^(-{3,}|\*{3,})$/.test(line.trim())) { flush(); out.push(<hr key={`b${k++}`} className="my-5 border-gray-200" />); continue; }
      const bullet = line.match(/^\s*[-*]\s+(.*)$/);
      if (bullet) {
        if (!list || list.type !== 'ul') { flush(); list = { type: 'ul', items: [] }; }
        list.items.push(bullet[1]);
        continue;
      }
      const numbered = line.match(/^\s*\d+\.\s+(.*)$/);
      if (numbered) {
        if (!list || list.type !== 'ol') { flush(); list = { type: 'ol', items: [] }; }
        list.items.push(numbered[1]);
        continue;
      }
      flush();
      out.push(<p key={`b${k++}`} className="mb-3 text-gray-700 leading-relaxed">{renderInline(line)}</p>);
    }
    flush();
    return out;
  }, [md]);

  return <div className="max-w-3xl">{blocks}</div>;
}

const fmtWhen = (d) => (d ? new Date(d).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');

// The in-app user guide. Employees see the employee guide; HR/Admins default to
// the HR guide, can switch to the employee view, and can EDIT either guide.
export default function HowToUse() {
  const { pathname } = useLocation();
  const isAdminPortal = pathname.startsWith('/admin');
  const user = useAuthStore((s) => s.user);
  const canEdit = hasPermission(user, 'announcements.manage');

  const [tab, setTab] = useState(isAdminPortal ? 'hr' : 'employee');
  const [remote, setRemote] = useState({}); // { employee: {content, updatedAt, updatedByName}, hr: {...} }
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

  const loadGuide = async (key) => {
    try {
      const { data } = await api.get(`/guides/${key}`);
      setRemote((r) => ({ ...r, [key]: data }));
    } catch {
      /* offline / not deployed — the bundled default is used */
    }
  };
  useEffect(() => { loadGuide(tab); setEditing(false); }, [tab]);

  const meta = remote[tab];
  const content = (meta && meta.content) || DEFAULTS[tab];

  const startEdit = () => { setDraft(content); setEditing(true); };
  const cancel = () => setEditing(false);

  const save = async () => {
    setSaving(true);
    try {
      const { data } = await api.put(`/guides/${tab}`, { content: draft });
      setRemote((r) => ({ ...r, [tab]: data }));
      setEditing(false);
      toast.success('Guide updated for everyone');
    } catch (e) {
      toast.error(e.response?.data?.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const resetDefault = async () => {
    const ok = await confirmDialog({
      message: 'Reset this guide to the built-in default? Any custom edits will be removed.',
      tone: 'danger',
      confirmText: 'Reset',
    });
    if (!ok) return;
    try {
      await api.delete(`/guides/${tab}`);
      setRemote((r) => ({ ...r, [tab]: { content: null } }));
      setEditing(false);
      toast.success('Reverted to the built-in guide');
    } catch (e) {
      toast.error(e.response?.data?.message || 'Reset failed');
    }
  };

  return (
    <div>
      <PageHeader title="How to Use the App" subtitle="A complete walkthrough of the HRMS - every screen and how to use it." />

      <div className="flex flex-wrap items-center gap-2 mb-4">
        {isAdminPortal && (
          <div className="inline-flex items-center gap-1 bg-gray-100 rounded-full p-0.5">
            <button onClick={() => setTab('hr')} className={`text-sm px-4 py-1.5 rounded-full transition-colors ${tab === 'hr' ? 'accent-bg text-white font-medium shadow-sm' : 'text-gray-600 hover:text-gray-900'}`}>HR / Admin guide</button>
            <button onClick={() => setTab('employee')} className={`text-sm px-4 py-1.5 rounded-full transition-colors ${tab === 'employee' ? 'accent-bg text-white font-medium shadow-sm' : 'text-gray-600 hover:text-gray-900'}`}>Employee guide</button>
          </div>
        )}

        {canEdit && (
          <div className="ml-auto flex items-center gap-2">
            {editing ? (
              <>
                <button onClick={resetDefault} className="px-3 py-2 text-sm text-red-600 border border-red-200 rounded-lg hover:bg-red-50">Reset to default</button>
                <button onClick={cancel} className="px-3 py-2 text-sm border rounded-lg hover:bg-gray-50">Cancel</button>
                <button onClick={save} disabled={saving} className="px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-60">{saving ? 'Saving…' : 'Save'}</button>
              </>
            ) : (
              <button onClick={startEdit} className="px-4 py-2 text-sm border border-indigo-300 text-indigo-700 rounded-lg hover:bg-indigo-50">Edit guide</button>
            )}
          </div>
        )}
      </div>

      {editing ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="bg-white shadow rounded-xl p-4 flex flex-col">
            <div className="text-xs font-semibold text-gray-500 mb-2">MARKDOWN · editing the {tab === 'hr' ? 'HR / Admin' : 'Employee'} guide</div>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              spellCheck={false}
              className="flex-1 min-h-[60vh] w-full font-mono text-[13px] leading-relaxed border border-gray-200 rounded-lg p-3 focus:outline-none focus:border-gray-400"
            />
            <p className="text-[11px] text-gray-400 mt-2">Supports Markdown: <code># heading</code>, <code>**bold**</code>, <code>*italic*</code>, <code>- bullet</code>, <code>1. numbered</code>, <code>---</code>. Saved for everyone.</p>
          </div>
          <div className="bg-white shadow rounded-xl p-5 sm:p-6 overflow-y-auto max-h-[75vh]">
            <div className="text-xs font-semibold text-gray-500 mb-3">LIVE PREVIEW</div>
            <MarkdownView md={draft} />
          </div>
        </div>
      ) : (
        <div className="bg-white shadow rounded-xl p-5 sm:p-8">
          <MarkdownView md={content} />
          {meta && meta.updatedAt && (
            <p className="text-[11px] text-gray-400 mt-6 pt-3 border-t border-gray-100">Last edited by {meta.updatedByName || 'HR'} · {fmtWhen(meta.updatedAt)}</p>
          )}
        </div>
      )}
    </div>
  );
}
