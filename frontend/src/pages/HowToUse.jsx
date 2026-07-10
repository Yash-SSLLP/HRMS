import { useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import PageHeader from '../components/PageHeader';
import { employeeGuide, hrGuide } from '../content/guides';

// --- Minimal, dependency-free Markdown renderer ---------------------------
// The guides use only: #/##/###/#### headings, **bold**, *italic*, "- " bullets,
// "1." numbered lists, "---" rules, and plain paragraphs (with emoji). No tables,
// code, links or blockquotes — so a small parser keeps the bundle lean.

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
    let list = null; // { type: 'ul'|'ol', items: [] }
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

// The in-app user guide. Employees see the employee guide; HR/Admins default to
// the HR guide but can switch to the employee view too.
export default function HowToUse() {
  const { pathname } = useLocation();
  const isAdminPortal = pathname.startsWith('/admin');
  const [tab, setTab] = useState(isAdminPortal ? 'hr' : 'employee');

  return (
    <div>
      <PageHeader title="How to Use the App" subtitle="A complete walkthrough of the HRMS — every screen and how to use it." />

      {isAdminPortal && (
        <div className="mb-4 inline-flex items-center gap-1 bg-gray-100 rounded-full p-0.5">
          <button
            onClick={() => setTab('hr')}
            className={`text-sm px-4 py-1.5 rounded-full transition-colors ${tab === 'hr' ? 'accent-bg text-white font-medium shadow-sm' : 'text-gray-600 hover:text-gray-900'}`}
          >
            HR / Admin guide
          </button>
          <button
            onClick={() => setTab('employee')}
            className={`text-sm px-4 py-1.5 rounded-full transition-colors ${tab === 'employee' ? 'accent-bg text-white font-medium shadow-sm' : 'text-gray-600 hover:text-gray-900'}`}
          >
            Employee guide
          </button>
        </div>
      )}

      <div className="bg-white shadow rounded-xl p-5 sm:p-8">
        <MarkdownView md={tab === 'hr' ? hrGuide : employeeGuide} />
      </div>
    </div>
  );
}
