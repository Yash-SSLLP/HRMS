/**
 * HowToUse — the in-app user guide screen (route /employee/how-to-use and
 * /admin/how-to-use). Employees see the employee guide; HR/Admins see the HR
 * guide and (with announcements.manage permission) can edit either. Loads/saves
 * the Markdown via GET/PUT/DELETE /guides/:key, falling back to bundled defaults.
 */
import { useDeferredValue, useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import '../styles/pages/org-help.css';
import { toast } from 'react-toastify';
import api from '../api/client';
import { useAuthStore } from '../store/authStore';
import { hasPermission } from '../config/permissions';
import { confirmDialog } from '../components/dialogs';
import PageHeader from '../components/PageHeader';
import { employeeGuide, hrGuide } from '../content/guides';
import { formatDateTime12 } from '../utils/time';

// The apps ship a bundled default guide; HR can override it (saved server-side).
const DEFAULTS = { employee: employeeGuide, hr: hrGuide };

import {
  FiInfo, FiZap, FiAlertCircle, FiAlertTriangle, FiEdit2, FiRotateCcw, FiCheck, FiList, FiShield, FiUser, FiClock,
} from 'react-icons/fi';

/**
 * Callout kinds. The guides mark these with a leading `[!NOTE]` / `[!TIP]` /
 * `[!IMPORTANT]` / `[!WARNING]` tag rather than an emoji, so the rendered page
 * draws a real vector icon that inherits the callout's colour and the reader's
 * font size. The uppercase label is deliberate: it carries the kind in TEXT as
 * well as in colour, so the distinction survives greyscale printing and
 * colour-blindness. The hue is mixed into the surface (.help-callout), so the
 * card holds in dark mode and in every portal accent.
 */
const CALLOUTS = {
  note: { Icon: FiInfo, label: 'Note', hue: '#0ea5e9' },
  tip: { Icon: FiZap, label: 'Tip', hue: '#6366f1' },
  important: { Icon: FiAlertCircle, label: 'Important', hue: '#8b5cf6' },
  warning: { Icon: FiAlertTriangle, label: 'Warning', hue: '#d97706' },
};

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
      <code key={key++} className="help-code">
        {m[4]}
      </code>
    );
    rest = rest.slice(m.index + m[0].length);
  }
  return nodes;
}

// Type scale lives in styles/pages/org-help.css (.help-h*); the gray text
// utilities stay because index.css remaps them for dark mode.
const HEADING_CLS = {
  1: 'help-h1 text-gray-900',
  2: 'help-h2 text-gray-900',
  3: 'help-h3 text-gray-900',
  4: 'help-h4 text-gray-600',
};

/**
 * A line tagged `[!NOTE] …` (optionally quoted, `> [!NOTE] …`) becomes a tinted
 * callout card.
 *
 * The two legacy emoji markers are still recognised. HR can save its own edited
 * copy of a guide server-side, so a guide written before this change is still
 * out there — it keeps rendering, and as a proper icon rather than the emoji.
 */
function calloutOf(line) {
  const tagged = line.match(/^>?\s*\[!(NOTE|TIP|IMPORTANT|WARNING)\]\s*(.*)$/i);
  if (tagged) return { ...CALLOUTS[tagged[1].toLowerCase()], body: tagged[2] };
  if (/^💡/.test(line)) return { ...CALLOUTS.tip, body: line.replace(/^💡\s*/, '') };
  if (/^⚠️?/.test(line)) return { ...CALLOUTS.warning, body: line.replace(/^⚠️?\s*/, '') };
  return null;
}

function MarkdownView({ md }) {
  const blocks = useMemo(() => {
    const lines = (md || '').split('\n');
    const out = [];
    let list = null;
    // Every block is keyed by the SOURCE LINE it came from, never by a running
    // counter. With a counter, pressing Enter near the top of a 1,400-line guide
    // shifted the key of every block below the caret, so React remounted the whole
    // document instead of the one paragraph that changed — the single biggest cost
    // in the editor's live preview. A line index is stable under edits further down,
    // and each line yields at most one block (a list is keyed by its first line), so
    // the keys stay unique.
    const flush = () => {
      if (!list) return;
      const items = list.items.map((t, i) => <li key={i}>{renderInline(t)}</li>);
      out.push(list.type === 'ol'
        ? <ol key={`b${list.at}`} className="help-list list-decimal text-gray-700">{items}</ol>
        : <ul key={`b${list.at}`} className="help-list list-disc text-gray-700">{items}</ul>);
      list = null;
    };
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const line = raw.replace(/\s+$/, '');
      if (!line.trim()) { flush(); continue; }

      if (/^#{1,4}\s+/.test(line)) {
        flush();
        const level = line.match(/^(#{1,4})/)[1].length;
        const text = line.replace(/^#{1,4}\s+/, '');
        const id = level === 2 || level === 3 ? slug(text) : undefined;
        const Tag = `h${level}`;
        out.push(<Tag key={`b${i}`} id={id} className={HEADING_CLS[level]}>{renderInline(text)}</Tag>);
        continue;
      }

      if (/^(-{3,}|\*{3,})$/.test(line.trim())) { flush(); out.push(<hr key={`b${i}`} className="help-hr" />); continue; }

      const callout = calloutOf(line.trim());
      if (callout) {
        flush();
        const { Icon } = callout;
        out.push(
          <div key={`b${i}`} className="help-callout" style={{ '--hue': callout.hue }}>
            <span className="help-callout-icon"><Icon size={16} aria-hidden="true" /></span>
            <div className="min-w-0">
              <div className="help-callout-label">{callout.label}</div>
              <p className="help-callout-body text-gray-700">{renderInline(callout.body)}</p>
            </div>
          </div>
        );
        continue;
      }

      const bullet = line.match(/^\s*[-*]\s+(.*)$/);
      if (bullet) {
        if (!list || list.type !== 'ul') { flush(); list = { type: 'ul', items: [], at: i }; }
        list.items.push(bullet[1]);
        continue;
      }
      const numbered = line.match(/^\s*\d+\.\s+(.*)$/);
      if (numbered) {
        if (!list || list.type !== 'ol') { flush(); list = { type: 'ol', items: [], at: i }; }
        list.items.push(numbered[1]);
        continue;
      }
      flush();
      out.push(<p key={`b${i}`} className="help-p text-gray-700">{renderInline(line)}</p>);
    }
    flush();
    return out;
  }, [md]);

  return <div className="help-prose">{blocks}</div>;
}

// On-this-page navigation, built from the guide's ## / ### headings: one row
// per chapter (##), and the open chapter's ### sections under it — 50-odd
// headings listed flat ran several screens down a sidebar.
function TableOfContents({ toc, activeId, onJump }) {
  if (!toc.length) return null;
  const groups = [];
  for (const h of toc) {
    if (h.level === 2 || !groups.length) groups.push({ head: h, kids: [] });
    else groups[groups.length - 1].kids.push(h);
  }
  const link = (h, cls, children) => (
    <a
      href={`#${h.id}`}
      onClick={(e) => { e.preventDefault(); onJump(h.id); }}
      // Active is colour only (same weight, same border width), so a label
      // can never re-wrap and shove every entry below it down a line.
      className={`help-toc-link ${cls}${activeId === h.id ? ' is-on' : ''}`}
      aria-current={activeId === h.id ? 'location' : undefined}
    >
      {children}
    </a>
  );
  return (
    <nav className="help-toc" aria-label="Contents">
      <ol className="help-toc-list">
        {groups.map(({ head, kids }) => {
          const open = activeId === head.id || kids.some((k) => k.id === activeId);
          const num = head.title.match(/^(\d+)\.\s+(.*)$/);
          return (
            <li key={head.id}>
              {link(head, 'is-h2', num ? (
                <>
                  <span className={`help-toc-num${open ? ' accent-bg text-white' : ''}`}>{num[1]}</span>
                  <span className="min-w-0">{num[2]}</span>
                </>
              ) : <span className="min-w-0">{head.title}</span>)}
              {open && kids.length > 0 && (
                <ul className="help-toc-sub">
                  {kids.map((k) => <li key={k.id}>{link(k, 'is-h3', k.title)}</li>)}
                </ul>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

const fmtWhen = (d) => formatDateTime12(d);

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
  // The live preview re-parses the WHOLE guide — the HR one is ~40KB / ~1,400 lines,
  // several thousand elements — and MarkdownView's useMemo is keyed on the string, so
  // typing was re-parsing and reconciling all of it on every keystroke. Deferring the
  // preview copy keeps the textarea at full speed and lets the next keystroke interrupt
  // the re-parse; the useMemo then short-circuits on the intervening ones, and because
  // `blocks` keeps its array reference React bails out of the preview subtree entirely.
  // A debounce timer would do the same job but would need clearing on unmount and on
  // cancel()/save(), and would flash a stale preview for its whole delay.
  const previewMd = useDeferredValue(draft);
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
  // Each line is right-trimmed first, exactly as MarkdownView does: the guides
  // are CRLF, and a trailing \r defeated `(.*)$` (`.` never matches \r), so
  // every heading was missed — the page read "0 sections" and drew no contents
  // while the renderer, which trims, drew all of them.
  const toc = useMemo(() => {
    const items = [];
    for (const raw of (content || '').split('\n')) {
      const m = raw.replace(/\s+$/, '').match(/^(#{2,3})\s+(.*)$/);
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
      <PageHeader
        title="Help"
        subtitle={!editing && toc.length ? `${toc.length} sections` : undefined}
      >
        {/* Edit actions (announcements.manage). */}
        {canEdit && (editing ? (
          <>
            <button type="button" onClick={resetDefault} className="trn-btn is-danger">
              <FiRotateCcw size={14} /> Reset to default
            </button>
            <button type="button" onClick={cancel} className="trn-btn">Cancel</button>
            <button type="button" onClick={save} disabled={saving} className="trn-btn is-primary accent-bg text-white">
              <FiCheck size={15} /> {saving ? 'Saving…' : 'Save'}
            </button>
          </>
        ) : (
          <button type="button" onClick={startEdit} className="trn-btn">
            <FiEdit2 size={14} /> Edit guide
          </button>
        ))}
      </PageHeader>

      {/* Guide switch (admin portal). .trn-seg keeps font-weight and border
          width on the base, so the strip never re-measures on click. */}
      {isAdminPortal && (
        <div className="help-bar">
          <div className="trn-seg" role="tablist" aria-label="Choose guide">
            <button type="button" role="tab" onClick={() => setTab('hr')}
              aria-selected={tab === 'hr'}
              className={`trn-seg-btn${tab === 'hr' ? ' is-on' : ''}`}>
              <FiShield size={14} aria-hidden="true" /> HR / Admin guide
            </button>
            <button type="button" role="tab" onClick={() => setTab('employee')}
              aria-selected={tab === 'employee'}
              className={`trn-seg-btn${tab === 'employee' ? ' is-on' : ''}`}>
              <FiUser size={14} aria-hidden="true" /> Employee guide
            </button>
          </div>
        </div>
      )}

      {editing ? (
        <div className="help-editor">
          <div className="help-pane flex flex-col">
            <div className="help-pane-head">
              <span className="help-pane-title">Markdown · {tab === 'hr' ? 'HR / Admin' : 'Employee'} guide</span>
              <span
                className="help-pane-hint"
                role="img"
                title="Supports Markdown: # heading, **bold**, *italic*, `code`, - bullet, 1. numbered, ---. Saved for everyone."
                aria-label="Markdown help"
              >
                <FiInfo size={14} />
              </span>
            </div>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              spellCheck={false}
              aria-label="Guide Markdown"
              className="help-textarea"
            />
          </div>
          <div className="help-pane help-pane-preview">
            <div className="help-pane-head">
              <span className="help-pane-title">Live preview</span>
            </div>
            <MarkdownView md={previewMd} />
          </div>
        </div>
      ) : (
        <div className="help-layout">
          {/* Sticky contents (desktop). */}
          {toc.length > 0 && (
            <aside className="help-aside">
              <div className="help-aside-head">
                <FiList size={14} aria-hidden="true" />
                <span>Contents</span>
              </div>
              <TableOfContents toc={toc} activeId={activeId} onJump={jump} />
            </aside>
          )}

          <article id="guide-content" className={`help-article${toc.length ? '' : ' is-wide'}`}>
            {/* Contents on a phone / tablet (the sidebar is desktop-only). */}
            {toc.length > 0 && (
              <details className="help-toc-mobile">
                <summary>
                  <FiList size={14} aria-hidden="true" />
                  <span>Contents</span>
                </summary>
                <div className="help-toc-mobile-body">
                  <TableOfContents toc={toc} activeId={activeId} onJump={jump} />
                </div>
              </details>
            )}

            <MarkdownView md={content} />

            {meta && meta.updatedAt && (
              <p className="help-edited">
                <FiClock size={12} aria-hidden="true" />
                Last edited by {meta.updatedByName || 'HR'} · {fmtWhen(meta.updatedAt)}
              </p>
            )}
          </article>
        </div>
      )}
    </div>
  );
}
