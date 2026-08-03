/**
 * FileDropField — one document slot on the public submission forms
 * (pages/DocumentSubmitForm.jsx for candidates, pages/EmployeeDocSubmit.jsx for
 * employees).
 *
 * One component, two shapes, decided by CSS rather than JS so there is no
 * breakpoint listener and no duplicated state:
 *   · phone  (< sm) — a full-width row, thumbnail on the left
 *   · desktop (≥ sm) — a tile in a two-column grid, thumbnail across the top
 *
 * A bare `<input type="file">` gave no feedback beyond "No file chosen", so
 * nobody could tell whether they had attached the right scan — or the right
 * side of it — until HR came back to them. Once something is attached the slot
 * shows the document itself, with View and Cancel on every file. Oversized
 * files are caught here rather than by the server after a long upload.
 *
 * Surfaces come from the `.docfield-*` tokens in index.css so both shapes
 * follow light/dark without literal fills.
 */
import { useEffect, useRef, useState } from 'react';
import { FiUploadCloud, FiFileText, FiPlus, FiX, FiEye, FiCheck } from 'react-icons/fi';

const isImage = (f) => (f?.type || '').startsWith('image/');
const isPdf = (f) => f?.type === 'application/pdf' || /\.pdf$/i.test(f?.name || '');
const previewable = (f) => isImage(f) || isPdf(f);

const prettySize = (bytes) => {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

// One blob URL per file, revoked when the file goes away — a preview must never
// outlive its slot, or a long form leaks every scan the user picked.
function useObjectUrl(file) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    if (!file) { setUrl(null); return undefined; }
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);
  return url;
}

// The attached document, shown at tile size. Images render themselves; anything
// else gets a document mark, so the slot always looks filled.
function Thumbnail({ file }) {
  const url = useObjectUrl(isImage(file) ? file : null);
  if (url) return <img src={url} alt="" className="docfield-face-img" />;
  return (
    <span className="docfield-face-doc">
      <FiFileText size={22} />
      <span className="text-[10px] font-semibold uppercase tracking-wide mt-1">
        {isPdf(file) ? 'PDF' : (file.name.split('.').pop() || 'file').slice(0, 4)}
      </span>
    </span>
  );
}

// Full-size look at one file before it is sent. Images render directly; PDFs go
// in an iframe with an "open in a new tab" escape hatch for browsers that block
// blob-URL framing.
function PreviewModal({ file, onClose }) {
  const url = useObjectUrl(file);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  if (!file || !url) return null;
  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={onClose}>
      <div className="docfield-preview w-full max-w-3xl max-h-[90vh] rounded-xl overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-4 py-3 docfield-preview-bar">
          <span className="min-w-0 flex-1 truncate text-sm font-semibold">{file.name}</span>
          <a href={url} target="_blank" rel="noreferrer" className="text-xs font-semibold shrink-0 docfield-action px-2 py-1 rounded-md">
            Open in a new tab
          </a>
          <button type="button" onClick={onClose} aria-label="Close preview" className="docfield-remove p-1 rounded-md shrink-0">
            <FiX size={18} />
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-auto flex items-center justify-center p-3">
          {isImage(file)
            ? <img src={url} alt={file.name} className="max-w-full max-h-[75vh] object-contain rounded-lg" />
            : <iframe src={url} title={file.name} className="w-full h-[75vh] rounded-lg border-0 bg-white" />}
        </div>
      </div>
    </div>
  );
}

/**
 * @param {string} label - document type shown as the slot heading
 * @param {string} [hint] - small grey note after the label
 * @param {boolean} [multiple] - allow several files for this type
 * @param {string} [accept] - input accept list
 * @param {File[]} files - currently picked files (controlled)
 * @param {(files: File[]) => void} onChange
 * @param {number} [maxSizeMb=10] - per-file ceiling, enforced before upload
 * @param {React.ReactNode} [badge] - status pill (e.g. HR's Verified/Rejected)
 */
export default function FileDropField({
  label, hint, multiple = false, accept, files = [], onChange, maxSizeMb = 10, badge,
}) {
  const inputRef = useRef(null);
  const [dragging, setDragging] = useState(false);
  const [sizeError, setSizeError] = useState('');
  const [preview, setPreview] = useState(null);

  const take = (list) => {
    const incoming = Array.from(list || []);
    if (!incoming.length) return;
    const tooBig = incoming.filter((f) => f.size > maxSizeMb * 1024 * 1024);
    const ok = incoming.filter((f) => f.size <= maxSizeMb * 1024 * 1024);
    setSizeError(tooBig.length
      ? `${tooBig.map((f) => f.name).join(', ')} — over ${maxSizeMb} MB, please attach a smaller copy.`
      : '');
    if (!ok.length) return;
    onChange(multiple ? [...files, ...ok] : [ok[0]]);
  };

  const removeAt = (i) => {
    onChange(files.filter((_, n) => n !== i));
    setSizeError('');
    if (inputRef.current) inputRef.current.value = ''; // let the same file be re-picked
  };

  const dropProps = {
    onDragOver: (e) => { e.preventDefault(); setDragging(true); },
    onDragLeave: () => setDragging(false),
    onDrop: (e) => { e.preventDefault(); setDragging(false); take(e.dataTransfer?.files); },
  };

  const has = files.length > 0;
  const face = files[files.length - 1]; // newest attachment is the slot's face

  return (
    <div className={`docfield ${has ? 'is-filled' : ''} ${dragging ? 'is-dragging' : ''}`}>
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-sm font-semibold docfield-label">{label}</span>
        {hint && <span className="text-xs docfield-meta">{hint}</span>}
        {has ? (
          <span className="docfield-count ml-auto inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full shrink-0">
            <FiCheck size={12} /> {multiple && files.length > 1 ? `${files.length} files` : 'Attached'}
          </span>
        ) : badge ? <span className="ml-auto shrink-0">{badge}</span> : null}
      </div>

      {has ? (
        <>
          {/* The document itself — this is the slot's face once something is on it. */}
          <div className="docfield-face" {...dropProps}>
            <Thumbnail file={face} />
          </div>

          {/* Every attached file gets View and Cancel of its own. */}
          <div className="mt-2 space-y-1.5">
            {files.map((f, i) => (
              <div key={`${f.name}-${i}`} className="docfield-filerow flex items-center gap-2">
                <span className="min-w-0 flex-1">
                  <span className="block text-xs font-medium truncate docfield-filename">{f.name}</span>
                  <span className="block text-[11px] docfield-meta">{prettySize(f.size)}</span>
                </span>
                {previewable(f) && (
                  <button type="button" onClick={() => setPreview(f)} title={`View ${f.name}`}
                    className="docfield-action shrink-0 inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-1 rounded-md">
                    <FiEye size={13} /> View
                  </button>
                )}
                <button type="button" onClick={() => removeAt(i)} title={`Cancel ${f.name}`}
                  className="docfield-cancel shrink-0 inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-1 rounded-md">
                  <FiX size={13} /> Cancel
                </button>
              </div>
            ))}
          </div>

          <button type="button" onClick={() => inputRef.current?.click()}
            className="docfield-replace mt-1.5 inline-flex items-center gap-1 text-[11px] font-semibold">
            <FiPlus size={12} /> {multiple ? 'Add another file' : 'Replace this file'}
          </button>
        </>
      ) : (
        <button type="button" onClick={() => inputRef.current?.click()} {...dropProps}
          className="docfield-zone w-full flex items-center gap-3 sm:flex-col sm:justify-center sm:gap-1.5 sm:text-center px-3 py-3 rounded-xl text-left">
          <span className="docfield-icon w-9 h-9 rounded-lg flex items-center justify-center shrink-0">
            <FiUploadCloud size={17} />
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-medium docfield-cta">Choose a file or drop it here</span>
            <span className="block text-[11px] docfield-meta">PDF, Word, JPG or PNG · up to {maxSizeMb} MB</span>
          </span>
        </button>
      )}

      <input
        ref={inputRef} type="file" multiple={multiple} className="hidden"
        accept={accept || '.pdf,.doc,.docx,.jpg,.jpeg,.png'}
        onChange={(e) => { take(e.target.files); e.target.value = ''; }}
      />

      {sizeError && <p className="mt-1.5 text-xs text-red-600">{sizeError}</p>}
      {preview && <PreviewModal file={preview} onClose={() => setPreview(null)} />}
    </div>
  );
}
