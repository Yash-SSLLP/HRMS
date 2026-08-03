/**
 * LetterEditor — read and edit the wording of a generated letter, and see the
 * real PDF, before it is created or sent.
 *
 * Until now HR could set the letter's *fields* (salary, dates, designation) but
 * never a sentence, and never saw the document until after it had been
 * generated — and by then the compose modal was already open with it attached.
 *
 * The body arrives from the server as blocks (paragraphs, and numbered terms on
 * the appointment letter) built from the current form values, so the editor
 * shows exactly what would print. Editing is optional: leave it alone and the
 * letter keeps following the standard template, including any later change to
 * it. Preview renders server-side from the values on screen and saves nothing.
 *
 * Used by the offer modal (pages/AdminRecruitment.jsx) and the appointment
 * modal (pages/AdminHiringOnboarding.jsx).
 */
import { useEffect, useRef, useState } from 'react';
import { FiChevronDown, FiChevronRight, FiEye, FiRotateCcw, FiTrash2, FiX } from 'react-icons/fi';
import api from '../api/client';

/** Full-size look at the rendered letter, from a blob the server just made. */
function PdfPreview({ url, title, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-[60] bg-black/70 flex items-center justify-center p-4" onClick={onClose}>
      <div className="docfield-preview w-full max-w-4xl max-h-[92vh] rounded-xl overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-4 py-3 docfield-preview-bar">
          <span className="min-w-0 flex-1 truncate text-sm font-semibold">{title}</span>
          <a href={url} target="_blank" rel="noreferrer" className="text-xs font-semibold shrink-0 docfield-action px-2 py-1 rounded-md">
            Open in a new tab
          </a>
          <button type="button" onClick={onClose} aria-label="Close preview" className="docfield-remove p-1 rounded-md shrink-0">
            <FiX size={18} />
          </button>
        </div>
        <iframe src={url} title={title} className="flex-1 min-h-[70vh] w-full border-0 bg-white" />
      </div>
    </div>
  );
}

/**
 * @param {string} candidateId
 * @param {'offer'|'appointment'} kind
 * @param {Object} form - the in-progress field values (sent with draft/preview)
 * @param {Object[]|null} value - edited blocks, or null while untouched
 * @param {(blocks: Object[]|null) => void} onChange - null means "standard wording"
 */
export default function LetterEditor({ candidateId, kind, form, value, onChange }) {
  const [open, setOpen] = useState(false);
  const [blocks, setBlocks] = useState(value || null);
  const [defaults, setDefaults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState(null);
  const urlRef = useRef(null);

  const label = kind === 'offer' ? 'offer letter' : 'appointment letter';

  // Fetch the wording once the section is opened — no point paying for it while
  // it is collapsed, which is how most letters go out.
  useEffect(() => {
    if (!open || blocks || loading) return;
    setLoading(true);
    api.post(`/recruitment/candidates/${candidateId}/letters/${kind}/draft`, form)
      .then(({ data }) => { setBlocks(data.blocks); setDefaults(data.defaults); })
      .catch((err) => setError(err.response?.data?.message || 'Could not load the letter text'))
      .finally(() => setLoading(false));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => { if (urlRef.current) URL.revokeObjectURL(urlRef.current); }, []);

  const edit = (i, patch) => {
    const next = blocks.map((b, n) => (n === i ? { ...b, ...patch } : b));
    setBlocks(next);
    onChange(next);
  };
  const removeAt = (i) => {
    const next = blocks.filter((_, n) => n !== i);
    setBlocks(next);
    onChange(next);
  };
  const reset = () => {
    setBlocks(defaults);
    onChange(null); // back to the standard template, not a copy of it
  };

  // Render from what is on screen right now. Saves nothing.
  const showPreview = async () => {
    setBusy(true); setError('');
    try {
      const res = await api.post(
        `/recruitment/candidates/${candidateId}/letters/${kind}/preview`,
        { ...form, body: blocks || undefined },
        { responseType: 'blob' },
      );
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = URL.createObjectURL(res.data);
      setPreview(urlRef.current);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not render the preview');
    } finally { setBusy(false); }
  };

  const closePreview = () => setPreview(null);

  return (
    <div className="border border-gray-200 rounded-lg mt-3">
      <div className="flex items-center gap-2 px-3 py-2">
        <button type="button" onClick={() => setOpen((o) => !o)}
          className="flex items-center gap-1.5 text-sm font-medium text-gray-800">
          {open ? <FiChevronDown size={15} /> : <FiChevronRight size={15} />}
          Letter wording
          {value && <span className="text-[10px] font-semibold uppercase tracking-wide bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded-full">edited</span>}
        </button>
        <button type="button" onClick={showPreview} disabled={busy}
          className="ml-auto inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1.5 rounded-lg border border-gray-300 hover:bg-gray-50 disabled:opacity-60">
          <FiEye size={13} /> {busy ? 'Rendering…' : 'Preview letter'}
        </button>
      </div>

      {open && (
        <div className="px-3 pb-3 border-t border-gray-100 pt-3">
          <p className="text-[11px] text-gray-500 mb-2">
            This is the {label} as it will print. Edit any part, or leave it to use the standard wording.
            The letterhead, salutation and signature block are always added.
          </p>

          {loading && <div className="text-sm text-gray-500">Loading the wording…</div>}

          {!loading && blocks && (
            <>
              <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
                {blocks.map((b, i) => (
                  <div key={i} className="rounded-lg border border-gray-100 p-2">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">
                        {b.type === 'term' ? 'Numbered term' : 'Paragraph'}
                      </span>
                      {b.type === 'term' && (
                        <input
                          value={b.head || ''} onChange={(e) => edit(i, { head: e.target.value })}
                          placeholder="Heading"
                          className="flex-1 border rounded px-2 py-1 text-xs font-medium"
                        />
                      )}
                      <button type="button" onClick={() => removeAt(i)} title="Remove this block"
                        className="ml-auto text-gray-400 hover:text-red-600 p-1 shrink-0">
                        <FiTrash2 size={13} />
                      </button>
                    </div>
                    <textarea
                      value={b.text} onChange={(e) => edit(i, { text: e.target.value })} rows={b.type === 'term' ? 2 : 3}
                      className="w-full border rounded px-2 py-1.5 text-xs leading-relaxed"
                    />
                  </div>
                ))}
              </div>

              <button type="button" onClick={reset}
                className="mt-2 inline-flex items-center gap-1.5 text-[11px] font-semibold text-gray-500 hover:text-gray-800">
                <FiRotateCcw size={12} /> Reset to standard wording
              </button>
            </>
          )}
        </div>
      )}

      {error && <p className="px-3 pb-2 text-xs text-red-600">{error}</p>}

      {preview && (
        <PdfPreview url={preview} title={`${kind === 'offer' ? 'Offer' : 'Appointment'} letter preview`} onClose={closePreview} />
      )}
    </div>
  );
}
