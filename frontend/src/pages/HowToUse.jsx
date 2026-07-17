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

// Stable id for a heading, shared by the renderer (anchors) and the ToC (links).
const slug = (s) =>
  s.toLowerCase().replace(/[^\w]+/g, '-').replace(/^-+|-+$/g, '') || 'section';

// --- Minimal, dependency-free Markdown renderer ---------------------------
// Handles what the guides use: #/##/###/#### headings (with anchor ids), **bold**,
// *italic*, `code`, "- " bullets, "1." numbered lists, "---" rules, 💡/⚠️ callouts,
// and plain paragraphs.

function renderInline(text) {
  const nodes = [];
  let rest = text;
  let key = 0;
  const re = /(\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`)/;
  while (rest) {
    const m = rest.match(re);
    if (!m) { nodes.push(rest); break; }
    if (m.index > 0) nodes.push(rest.slice(0, m.index));
    if (m[2] != null) nodes.push(<strong key={key++} className="font-semibold text-gray-900">{m[2]}</strong>);
    else if (m[3] != null) nodes.push(<em key={key++}>{m[3]}</em>);
    else nodes.push(
      <code key={key++} className="px-1.5 py-0.5 rounded bg-gray-100 border border-gray-200 font-mono text-[0.82em] text-gray-800">
        {m[4]}
      </code>
    );
    rest = rest.slice(m.index + m[0].length);
  }
  return nodes;
}

const HEADING_CLS = {
  1: 'text-2xl sm:text-3xl font-bold text-gray-900 mt-1 mb-2 tracking-tight',
  2: 'text-lg font-bold text-gray-900 mt-10 mb-3 pb-2 border-b border-gray-100 scroll-mt-24',
  3: 'text-[15px] font-semibold text-gray-900 mt-6 mb-2 scroll-mt-24',
  4: 'text-sm font-semibold text-gray-600 mt-4 mb-1.5',
};

// 💡 tip / ⚠️ warning paragraphs render as tinted callout cards.
function calloutOf(line) {
  if (/^💡/.test(line)) return { icon: '💡', cls: 'border-indigo-400 bg-indigo-50 text-indigo-800', body: line.replace(/^💡\s*/, '') };
  if (/^⚠️?/.test(line)) return { icon: '⚠️', cls: 'border-amber-400 bg-amber-50 text-amber-800', body: line.replace(/^⚠️?\s*/, '') };
  return null;
}

function MarkdownView({ md }) {
  const blocks = useMemo(() => {
    const lines = (md || '').split('\n');
    const out = [];
    let list = null;
    let k = 0;
    const flush = () => {
      if (!list) return;
      const items = list.items.map((t, i) => <li key={i} className="mb-1.5 pl-1">{renderInline(t)}</li>);
      out.push(list.type === 'ol'
        ? <ol key={`b${k++}`} className="list-decimal pl-6 mb-4 text-gray-700 leading-relaxed marker:text-gray-400">{items}</ol>
        : <ul key={`b${k++}`} className="list-disc pl-6 mb-4 text-gray-700 leading-relaxed marker:text-gray-300">{items}</ul>);
      list = null;
    };
    for (const raw of lines) {
      const line = raw.replace(/\s+$/, '');
      if (!line.trim()) { flush(); continue; }

      if (/^#{1,4}\s+/.test(line)) {
        flush();
        const level = line.match(/^(#{1,4})/)[1].length;
        const text = line.replace(/^#{1,4}\s+/, '');
        const id = level === 2 || level === 3 ? slug(text) : undefined;
        const Tag = `h${level}`;
        out.push(<Tag key={`b${k++}`} id={id} className={HEADING_CLS[level]}>{renderInline(text)}</Tag>);
        continue;
      }

      if (/^(-{3,}|\*{3,})$/.test(line.trim())) { flush(); out.push(<hr key={`b${k++}`} className="my-7 border-gray-100" />); continue; }

      const callout = calloutOf(line.trim());
      if (callout) {
        flush();
        out.push(
          <div key={`b${k++}`} className={`flex gap-3 my-4 rounded-lg border-l-4 px-4 py-3 ${callout.cls}`}>
            <span className="text-base leading-6 shrink-0">{callout.icon}</span>
            <p className="text-sm leading-relaxed m-0">{renderInline(callout.body)}</p>
          </div>
        );
        continue;
      }

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
      out.push(<p key={`b${k++}`} className="mb-3.5 text-gray-700 leading-relaxed">{renderInline(line)}</p>);
    }
    flush();
    return out;
  }, [md]);

  return <div className="max-w-none">{blocks}</div>;
}

// On-this-page navigation, built from the guide's ## / ### headings.
function TableOfContents({ toc, activeId, onJump }) {
  if (!toc.length) return null;
  return (
    <nav className="text-sm">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 mb-3">On this page</div>
      <ul className="border-l border-gray-200">
        {toc.map((h) => {
          const active = activeId === h.id;
          return (
            <li key={h.id}>
              <a
                href={`#${h.id}`}
                onClick={(e) => { e.preventDefault(); onJump(h.id); }}
                className={[
                  'block -ml-px border-l-2 py-1.5 leading-snug transition-colors',
                  h.level === 3 ? 'pl-6 text-[13px]' : 'pl-4',
                  active ? 'border-current accent-text font-medium' : 'border-transparent text-gray-500 hover:text-gray-900 hover:border-gray-300',
                ].join(' ')}
              >
                {h.title}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
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
  const [activeId, setActiveId] = useState('');

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

  // Table of contents from ## / ### headings (matches the renderer's anchor ids).
  const toc = useMemo(() => {
    const items = [];
    for (const raw of (content || '').split('\n')) {
      const m = raw.match(/^(#{2,3})\s+(.*)$/);
      if (m) items.push({ level: m[1].length, id: slug(m[2]), title: m[2].replace(/\*\*|`/g, '') });
    }
    return items;
  }, [content]);

  // Scrollspy: highlight the section currently in view.
  useEffect(() => {
    if (editing) return undefined;
    const container = document.getElementById('guide-content');
    if (!container) return undefined;
    const headings = [...container.querySelectorAll('h2[id], h3[id]')];
    if (!headings.length) return undefined;
    setActiveId(headings[0].id);
    const obs = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActiveId(visible[0].target.id);
      },
      { rootMargin: '-88px 0px -70% 0px', threshold: 0 }
    );
    headings.forEach((h) => obs.observe(h));
    return () => obs.disconnect();
  }, [content, editing, tab]);

  const jump = (id) => {
    const el = document.getElementById(id);
    if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'start' }); setActiveId(id); }
  };

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

      {/* Controls: guide switch (admin) + edit actions */}
      <div className="flex flex-wrap items-center gap-2 mb-5">
        {isAdminPortal && (
          <div className="inline-flex items-center gap-1 bg-gray-100 rounded-full p-0.5">
            <button onClick={() => setTab('hr')} className={`text-sm px-4 py-1.5 rounded-full transition-colors ${tab === 'hr' ? 'accent-bg text-white font-medium shadow-sm' : 'text-gray-600 hover:text-gray-900'}`}>HR / Admin guide</button>
            <button onClick={() => setTab('employee')} className={`text-sm px-4 py-1.5 rounded-full transition-colors ${tab === 'employee' ? 'accent-bg text-white font-medium shadow-sm' : 'text-gray-600 hover:text-gray-900'}`}>Employee guide</button>
          </div>
        )}
        {!editing && <span className="text-xs text-gray-400">{toc.length} sections</span>}

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
            <p className="text-[11px] text-gray-400 mt-2">Supports Markdown: <code># heading</code>, <code>**bold**</code>, <code>*italic*</code>, <code>`code`</code>, <code>- bullet</code>, <code>1. numbered</code>, <code>---</code>. Saved for everyone.</p>
          </div>
          <div className="bg-white shadow rounded-xl p-5 sm:p-6 overflow-y-auto max-h-[75vh]">
            <div className="text-xs font-semibold text-gray-500 mb-3">LIVE PREVIEW</div>
            <MarkdownView md={draft} />
          </div>
        </div>
      ) : (
        <div className="lg:flex lg:gap-8 lg:items-start">
          <article id="guide-content" className="flex-1 min-w-0 bg-white rounded-xl border border-gray-100 shadow-sm px-5 py-6 sm:px-10 sm:py-9">
            {/* Mobile "on this page" (the sidebar is desktop-only) */}
            {toc.length > 0 && (
              <details className="lg:hidden mb-6 rounded-lg border border-gray-200 bg-gray-50">
                <summary className="cursor-pointer select-none px-4 py-2.5 text-sm font-medium text-gray-700">On this page</summary>
                <div className="px-4 pb-3">
                  <TableOfContents toc={toc} activeId={activeId} onJump={jump} />
                </div>
              </details>
            )}

            <MarkdownView md={content} />

            {meta && meta.updatedAt && (
              <p className="text-[11px] text-gray-400 mt-8 pt-4 border-t border-gray-100">Last edited by {meta.updatedByName || 'HR'} · {fmtWhen(meta.updatedAt)}</p>
            )}
          </article>

          {/* Sticky table of contents (desktop) */}
          <aside className="hidden lg:block w-60 shrink-0 sticky top-20 self-start max-h-[calc(100vh-6rem)] overflow-y-auto pb-6">
            <TableOfContents toc={toc} activeId={activeId} onJump={jump} />
          </aside>
        </div>
      )}
    </div>
  );
}
