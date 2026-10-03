/**
 * Proof attached to a regularization request — photos or PDFs (2026-09-30,
 * user: "while regularisation give option to upload photos or PDF").
 *
 *   <ProofPicker files={files} onChange={setFiles} />  the form's file box
 *   <ProofLinks reg={r} />                              the files, openable
 *
 * Files are read through GET /regularizations/:id/attachments/:fileId (bearer
 * token, so fetched as a blob and opened in a new tab — never an <a href>).
 */
import { useRef } from 'react';
import { toast } from 'react-toastify';
import { FiPaperclip, FiX, FiFileText, FiImage } from 'react-icons/fi';
import { openProtectedPdf } from '../api/download';

export const PROOF_MAX = 5;
export const PROOF_MAX_MB = 10;
const PROOF_ACCEPT = '.pdf,.jpg,.jpeg,.png,.webp,.heic,.heif,application/pdf,image/jpeg,image/png,image/webp,image/heic,image/heif';
const isImage = (f) => /^image\//i.test(f.contentType || f.type || '') || /\.(jpe?g|png|webp|heic|heif)$/i.test(f.name || '');

/** The form's file box: pick up to five photos or PDFs, see them, take one off. */
export function ProofPicker({ files, onChange }) {
  const input = useRef(null);
  const add = (list) => {
    const picked = [...(list || [])];
    const tooBig = picked.filter((f) => f.size > PROOF_MAX_MB * 1024 * 1024);
    if (tooBig.length) toast.error(`${tooBig.map((f) => f.name).join(', ')} — over ${PROOF_MAX_MB} MB.`);
    const next = [...files, ...picked.filter((f) => f.size <= PROOF_MAX_MB * 1024 * 1024)];
    if (next.length > PROOF_MAX) toast.info(`Up to ${PROOF_MAX} files — the first ${PROOF_MAX} are kept.`);
    onChange(next.slice(0, PROOF_MAX));
  };
  return (
    <div>
      <label className="block text-sm text-gray-700">Proof <span className="text-gray-400">(optional — photos or PDF)</span></label>
      <input ref={input} type="file" multiple accept={PROOF_ACCEPT} className="hidden"
        onChange={(e) => { add(e.target.files); e.target.value = ''; }} />
      {files.length > 0 && (
        <ul className="mt-1.5 space-y-1">
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`} className="flex items-center gap-2 text-sm bg-gray-50 border border-gray-200 rounded-lg px-2.5 py-1.5">
              {isImage(f) ? <FiImage size={14} className="shrink-0 text-gray-500" /> : <FiFileText size={14} className="shrink-0 text-gray-500" />}
              <span className="min-w-0 flex-1 truncate">{f.name}</span>
              <span className="text-[11px] text-gray-400 shrink-0">{(f.size / 1024 / 1024).toFixed(1)} MB</span>
              <button type="button" onClick={() => onChange(files.filter((_, j) => j !== i))}
                className="shrink-0 text-gray-400 hover:text-red-600" aria-label={`Remove ${f.name}`}>
                <FiX size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {files.length < PROOF_MAX && (
        <button type="button" onClick={() => input.current?.click()}
          className="mt-1.5 inline-flex items-center gap-1.5 text-sm px-3 py-2 rounded-lg border border-dashed border-gray-300 text-gray-600 hover:bg-gray-50">
          <FiPaperclip size={14} /> {files.length ? 'Add another' : 'Attach a photo or PDF'}
        </button>
      )}
      <p className="text-[11px] text-gray-400 mt-1">Up to {PROOF_MAX} files, {PROOF_MAX_MB} MB each.</p>
    </div>
  );
}

/** The files on a request, each opening in a new tab. Nothing when there are none. */
export function ProofLinks({ reg, className = '' }) {
  const files = reg?.attachments || [];
  if (!files.length) return null;
  const open = (f) => openProtectedPdf(`/regularizations/${reg._id}/attachments/${f._id}`, 'Could not open that file')
    .catch((err) => toast.error(err.message));
  return (
    <div className={`flex flex-wrap gap-1.5 mt-1 ${className}`}>
      {files.map((f) => (
        <button key={f._id} type="button" onClick={() => open(f)} title={`Open ${f.name}`}
          className="inline-flex items-center gap-1 max-w-[14rem] text-[11px] px-2 py-1 rounded-lg border border-gray-200 bg-white text-gray-700 hover:bg-gray-50">
          {isImage(f) ? <FiImage size={12} className="shrink-0" /> : <FiFileText size={12} className="shrink-0" />}
          <span className="truncate">{f.name || 'Attachment'}</span>
        </button>
      ))}
    </div>
  );
}
