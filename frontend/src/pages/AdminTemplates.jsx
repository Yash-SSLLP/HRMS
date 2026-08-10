/**
 * AdminTemplates — edit what every outgoing email and letter SAYS.
 *
 * The catalogue is defined server-side (services/templateRegistry.js); this page
 * lists it with any org overrides applied, edits one at a time, previews the
 * result with sample values, and can drop an override to go back to the shipped
 * wording. Page layout of the letter PDFs (letterhead, fonts, signature block)
 * is not editable here — only the text.
 *
 * Gated by the 'templates.manage' capability.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'react-toastify';
import { FiEye, FiRotateCcw, FiSave, FiMail, FiFileText } from 'react-icons/fi';
import api from '../api/client';
import PageHeader from '../components/PageHeader';
import { confirmDialog } from '../components/dialogs';

const FORMAT_META = {
  mail: { label: 'Email', icon: FiMail, tone: 'bg-blue-100 text-blue-800' },
  letter: { label: 'Letter (PDF)', icon: FiFileText, tone: 'bg-violet-100 text-violet-800' },
};

export default function AdminTemplates() {
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [activeKey, setActiveKey] = useState('');
  const [draft, setDraft] = useState({ subject: '', body: '' });
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState(null);
  const bodyRef = useRef(null);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const { data } = await api.get('/templates');
      setTemplates(data.templates || []);
      setActiveKey((k) => k || data.templates?.[0]?.key || '');
    } catch (err) {
      setError(err.response?.data?.message || 'Could not load templates');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const active = useMemo(
    () => templates.find((t) => t.key === activeKey) || null,
    [templates, activeKey]
  );

  // Load the selected template into the editor. Keyed on the template's own
  // content too, so a save or reset refreshes what is on screen.
  useEffect(() => {
    if (!active) return;
    setDraft({ subject: active.subject || '', body: active.body || '' });
    setPreview(null);
  }, [active?.key, active?.subject, active?.body]);

  const dirty = !!active && (draft.subject !== (active.subject || '') || draft.body !== (active.body || ''));

  // Group the list the same way the server groups it, so related templates sit
  // together rather than in registry order.
  const groups = useMemo(() => {
    const out = new Map();
    for (const t of templates) {
      if (!out.has(t.group)) out.set(t.group, []);
      out.get(t.group).push(t);
    }
    return [...out.entries()];
  }, [templates]);

  /** Insert a {{variable}} at the caret, so it lands where the editor is typing. */
  const insertVariable = (name) => {
    const el = bodyRef.current;
    const token = `{{${name}}}`;
    if (!el) { setDraft((d) => ({ ...d, body: `${d.body}${token}` })); return; }
    const { selectionStart: s, selectionEnd: e, value } = el;
    const next = `${value.slice(0, s)}${token}${value.slice(e)}`;
    setDraft((d) => ({ ...d, body: next }));
    // Put the caret after the inserted token once React has re-rendered.
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(s + token.length, s + token.length);
    });
  };

  const doPreview = async () => {
    if (!active) return;
    try {
      const { data } = await api.post(`/templates/${active.key}/preview`, draft);
      setPreview(data);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not render the preview');
    }
  };

  const doSave = async () => {
    if (!active) return;
    setSaving(true);
    try {
      const { data } = await api.put(`/templates/${active.key}`, draft);
      setTemplates((prev) => prev.map((t) => (t.key === data.template.key ? data.template : t)));
      toast.success(`${active.name} saved — it applies to the next one sent`);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not save');
    } finally {
      setSaving(false);
    }
  };

  const doReset = async () => {
    if (!active) return;
    const ok = await confirmDialog({
      title: 'Restore the original wording?',
      message: `“${active.name}” will go back to the wording the system ships with. Your edited version is discarded.`,
      confirmText: 'Reset to default',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      const { data } = await api.delete(`/templates/${active.key}`);
      setTemplates((prev) => prev.map((t) => (t.key === data.template.key ? data.template : t)));
      toast.success('Restored the default wording');
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not reset');
    }
  };

  const Meta = active ? FORMAT_META[active.format] : null;

  return (
    <div>
      <PageHeader
        title="Email & Letter Templates"
        subtitle="Change what the system says when it emails a candidate or an employee, and the wording of the offer and appointment letters."
      />

      {error && (
        <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>
      )}

      {loading ? (
        <div className="bg-white shadow rounded-lg p-6 space-y-2.5">
          <div className="skeleton h-4 rounded" />
          <div className="skeleton h-4 rounded w-5/6" />
          <div className="skeleton h-4 rounded w-2/3" />
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-[18rem_1fr] gap-4 items-start">
          {/* ---- catalogue ---- */}
          <div className="bg-white shadow rounded-lg overflow-hidden">
            {groups.map(([group, items]) => (
              <div key={group}>
                <div className="px-4 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-400">{group}</div>
                {items.map((t) => {
                  const Icon = FORMAT_META[t.format]?.icon || FiMail;
                  const isActive = t.key === activeKey;
                  return (
                    <button
                      key={t.key}
                      onClick={() => setActiveKey(t.key)}
                      className={`w-full text-left px-4 py-2.5 flex items-start gap-2.5 border-l-2 transition-colors ${
                        isActive ? 'accent-text border-current bg-gray-50' : 'border-transparent hover:bg-gray-50'}`}
                    >
                      <Icon size={15} className="mt-0.5 shrink-0 opacity-70" />
                      <span className="min-w-0">
                        <span className="block text-sm font-medium truncate">{t.name}</span>
                        {t.isOverridden && (
                          <span className="text-[11px] text-amber-700">Edited</span>
                        )}
                      </span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>

          {/* ---- editor ---- */}
          {!active ? (
            <div className="bg-white shadow rounded-lg p-6 text-sm text-gray-500">Select a template.</div>
          ) : (
            <div className="bg-white shadow rounded-lg p-5">
              <div className="flex flex-wrap items-start justify-between gap-3 mb-1">
                <div className="min-w-0">
                  <h2 className="card-title">{active.name}</h2>
                  <p className="text-sm text-gray-500 mt-0.5">{active.description}</p>
                </div>
                <span className={`shrink-0 px-2 py-0.5 text-xs rounded-lg ${Meta.tone}`}>{Meta.label}</span>
              </div>

              {active.format === 'letter' && (
                <p className="text-[11px] text-gray-400 mt-2">
                  Blank line starts a new paragraph · <code>**wrap in stars**</code> for a bold paragraph ·
                  {' '}<code>- Heading: text</code> for a numbered clause. The letterhead, fonts and signature block are fixed.
                </p>
              )}

              {active.format === 'mail' && (
                <div className="mt-4">
                  <label className="block text-sm text-gray-700">Subject</label>
                  <input
                    value={draft.subject}
                    onChange={(e) => setDraft({ ...draft, subject: e.target.value })}
                    className="mt-1 block w-full border rounded-lg px-3 py-2"
                  />
                </div>
              )}

              <div className="mt-4">
                <label className="block text-sm text-gray-700">
                  {active.format === 'letter' ? 'Letter body' : 'Message'}
                </label>
                <textarea
                  ref={bodyRef}
                  rows={active.format === 'letter' ? 18 : 12}
                  value={draft.body}
                  onChange={(e) => setDraft({ ...draft, body: e.target.value })}
                  className="mt-1 block w-full border rounded-lg px-3 py-2 font-mono text-[13px] leading-relaxed"
                />
              </div>

              <div className="mt-3">
                <div className="text-xs text-gray-500 mb-1.5">
                  Click to insert. A placeholder with no value is left visible rather than blanked, so a mistake is obvious.
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {(active.variables || []).map((v) => (
                    <button
                      key={v} type="button" onClick={() => insertVariable(v)}
                      className="font-mono text-[11px] px-2 py-1 rounded-lg border bg-gray-50 hover:bg-gray-100"
                    >
                      {`{{${v}}}`}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2 pt-4 mt-4 border-t border-gray-100">
                <button type="button" onClick={doPreview}
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">
                  <FiEye size={15} /> Preview
                </button>
                <button type="button" onClick={doReset} disabled={!active.isOverridden}
                  title={active.isOverridden ? 'Restore the shipped wording' : 'This template is already the default'}
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-sm border rounded-lg hover:bg-gray-50 disabled:opacity-50">
                  <FiRotateCcw size={15} /> Reset to default
                </button>
                <span className="ml-auto text-xs text-gray-400">
                  {dirty ? 'Unsaved changes' : active.isOverridden ? 'Using your edited version' : 'Using the default wording'}
                </span>
                <button type="button" onClick={doSave} disabled={saving || !dirty}
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60">
                  <FiSave size={15} /> {saving ? 'Saving…' : 'Save'}
                </button>
              </div>

              {preview && (
                <div className="mt-4 border rounded-lg overflow-hidden">
                  <div className="px-3 py-2 text-xs font-semibold text-gray-500 border-b" style={{ background: 'var(--surface-2)' }}>
                    Preview — sample values
                  </div>
                  <div className="p-4">
                    {preview.subject && (
                      <div className="text-sm font-semibold text-gray-900 mb-2">{preview.subject}</div>
                    )}
                    <div className="text-sm text-gray-700 whitespace-pre-wrap">{preview.body}</div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
