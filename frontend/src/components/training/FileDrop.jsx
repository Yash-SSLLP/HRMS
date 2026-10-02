/**
 * Files to hand out with a training: a drop zone (drag files in, or click to
 * choose) plus the list of what is attached — files already on the training
 * and the ones picked now, which upload when the form is saved.
 *
 * Too-big files and anything past the per-training ceiling are refused HERE,
 * with a sentence, before a long upload fails on the server.
 */
import { useRef, useState } from 'react';
import { toast } from 'react-toastify';
import { FiUploadCloud } from 'react-icons/fi';
import { FileRow } from './bits';
import { MAX_FILE_MB, MAX_FILES } from './trainingUtil';

const ACCEPT = '.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.zip,.jpg,.jpeg,.png,.webp,.gif,image/*';

export default function FileDrop({ existing = [], pending = [], onAddFiles, onRemoveExisting, onRemovePending }) {
  const inputRef = useRef(null);
  const [over, setOver] = useState(false);
  const count = existing.length + pending.length;

  const take = (list) => {
    const files = Array.from(list || []);
    if (!files.length) return;
    const room = MAX_FILES - count;
    const tooBig = files.filter((f) => f.size > MAX_FILE_MB * 1024 * 1024);
    const fits = files.filter((f) => f.size <= MAX_FILE_MB * 1024 * 1024);
    if (tooBig.length) toast.error(`${tooBig.map((f) => f.name).join(', ')} ${tooBig.length === 1 ? 'is' : 'are'} over ${MAX_FILE_MB} MB.`);
    if (fits.length > room) toast.error(`A training can carry up to ${MAX_FILES} files — only ${Math.max(0, room)} more could be added.`);
    const accepted = fits.slice(0, Math.max(0, room));
    if (accepted.length) onAddFiles(accepted);
  };

  return (
    <div className="space-y-2.5">
      <div
        role="button"
        tabIndex={0}
        className={`trn-drop ${over ? 'is-over' : ''}`}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inputRef.current?.click(); } }}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); take(e.dataTransfer.files); }}
      >
        <span className="trn-empty-icon" style={{ width: '2.6rem', height: '2.6rem', borderRadius: '0.8rem' }}><FiUploadCloud size={20} /></span>
        <span className="text-sm font-semibold text-gray-900">Drop files here, or <span className="accent-text">browse</span></span>
        <span className="text-xs text-gray-500">Slides, PDFs, documents, pictures · up to {MAX_FILE_MB} MB each · {MAX_FILES} files</span>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={ACCEPT}
          className="hidden"
          onChange={(e) => { take(e.target.files); e.target.value = ''; }}
        />
      </div>
      {count > 0 && (
        <div className="trn-files">
          {existing.map((f) => (
            <FileRow key={f._id} file={f} onRemove={onRemoveExisting ? () => onRemoveExisting(f) : undefined} />
          ))}
          {pending.map((f, i) => (
            <FileRow key={`${f.name}-${f.size}-${i}`} file={{ name: f.name, size: f.size, mime: f.type }} pending onRemove={() => onRemovePending(i)} />
          ))}
        </div>
      )}
    </div>
  );
}
