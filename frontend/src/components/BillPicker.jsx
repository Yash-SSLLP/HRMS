/**
 * BillPicker — the bills on a cashbook entry, SEVERAL at once.
 *
 * NEW 2026-09-28. The user: *"in cashbook while showing any expense give
 * option to select multiple images and capture multiple images options in
 * single expense"*. Every cash form used to hold ONE file ("Upload file" or
 * "Take photo", then a chip with its name); a trip with a fuel slip, a toll
 * receipt and a lunch bill had to be three expenses or one photo of three
 * papers. Now:
 *
 *   Take photos    the camera stays open — "Use & take another" — until Done
 *   Upload files   the file picker takes several at once (images or PDFs)
 *
 * and every bill is a tile that can be removed on its own. On an EDIT the bills
 * already on the entry are tiles too; removing one only takes it out of `keep`,
 * which the form sends as `keepBills` — the server deletes the file once the
 * edit is saved, never before (controllers/khataController.editBills).
 *
 * The server takes at most MAX_BILLS (utils/bills.MAX_BILLS) and 5 MB each; both
 * are checked here first so a refusal is a sentence beside the button rather
 * than a failed save.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'react-toastify';
import { FiCamera, FiUpload, FiX, FiFileText, FiEye } from 'react-icons/fi';
import CameraCapture from './CameraCapture';

/** Mirrors backend/utils/bills.MAX_BILLS. */
export const MAX_BILLS = 10;
const MAX_BYTES = 5 * 1024 * 1024;

const isImage = (f) => /^image\//i.test(f?.type || f?.mime || '');
const kb = (n) => (n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/**
 * @param {object} props
 * @param {File[]} props.files                 new bills, not yet uploaded
 * @param {(files: File[]) => void} props.onFilesChange
 * @param {Array<{i:number,name:string,mime:string}>} [props.existing]  bills already on the entry (edit)
 * @param {number[]} [props.keep]              which of `existing` stay (edit)
 * @param {(keep: number[]) => void} [props.onKeepChange]
 * @param {(i: number) => void} [props.onViewExisting]  open one already attached
 * @param {boolean} [props.required]
 * @param {string} [props.label]
 * @param {string} [props.hint]
 * @param {string} [props.cameraTitle]
 * @param {string} [props.fileName]            base name for photos taken here
 * @param {boolean} [props.disabled]
 */
export default function BillPicker({
  files = [], onFilesChange,
  existing = [], keep = [], onKeepChange, onViewExisting,
  required = false, label = 'Bills or receipts', hint = '',
  cameraTitle = 'Photograph the bills', fileName = 'bill', disabled = false,
}) {
  const inputRef = useRef(null);
  const [camera, setCamera] = useState(false);
  // The room there was when the camera OPENED: the camera counts its own
  // shots against it, so it must not shrink under it as each photo lands.
  const [cameraRoom, setCameraRoom] = useState(0);

  // The newest list, for callbacks that fire several times before the parent
  // re-renders (the camera hands over each photo the moment it is kept).
  const filesRef = useRef(files);
  filesRef.current = files;

  const kept = existing.filter((b) => keep.includes(b.i));
  const count = kept.length + files.length;
  const room = Math.max(0, MAX_BILLS - count);

  // Thumbnails for new photos, released when they change or the form closes.
  const previews = useMemo(() => files.map((f) => (isImage(f) ? URL.createObjectURL(f) : null)), [files]);
  useEffect(() => () => previews.forEach((u) => u && URL.revokeObjectURL(u)), [previews]);

  const add = (list) => {
    const incoming = [...list];
    const tooBig = incoming.filter((f) => f.size > MAX_BYTES);
    const fits = incoming.filter((f) => f.size <= MAX_BYTES);
    if (tooBig.length) {
      toast.error(`${tooBig.map((f) => f.name).join(', ')} ${tooBig.length === 1 ? 'is' : 'are'} over 5 MB — take a photo of it instead.`);
    }
    const space = Math.max(0, MAX_BILLS - kept.length - filesRef.current.length);
    if (fits.length > space) {
      toast.error(`An entry can carry ${MAX_BILLS} bills — ${fits.length - space} ${fits.length - space === 1 ? 'was' : 'were'} left out.`);
    }
    const next = [...filesRef.current, ...fits.slice(0, space)];
    filesRef.current = next;
    onFilesChange?.(next);
  };

  const removeNew = (idx) => onFilesChange?.(files.filter((_, j) => j !== idx));
  const removeKept = (i) => onKeepChange?.(keep.filter((k) => k !== i));

  const tile = 'relative flex items-center gap-2 rounded-lg border border-gray-200 bg-white py-1.5 pl-1.5 pr-8 text-xs min-w-0 max-w-full sm:max-w-[16rem]';

  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 mb-1">
        <span className="text-xs font-medium text-gray-600">
          {label}{required && <span className="text-red-500"> *</span>}
        </span>
        <span className="text-[11px] text-gray-400 tabular-nums">{count} of {MAX_BILLS}</span>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => { setCameraRoom(room); setCamera(true); }}
          disabled={disabled || room <= 0}
          className="inline-flex items-center gap-1.5 rounded-lg border px-3 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50 min-h-[38px]"
        >
          <FiCamera size={15} /> Take photos
        </button>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={disabled || room <= 0}
          className="inline-flex items-center gap-1.5 rounded-lg border px-3 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50 min-h-[38px]"
        >
          <FiUpload size={15} /> Upload files
        </button>
        <input
          ref={inputRef}
          type="file"
          accept="image/*,application/pdf"
          multiple
          hidden
          onChange={(e) => { add(e.target.files || []); e.target.value = ''; }}
        />
      </div>

      {count > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {kept.map((b) => (
            <div key={`kept-${b.i}`} className={tile}>
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-gray-100 text-gray-500">
                <FiFileText size={15} />
              </span>
              <span className="min-w-0">
                <span className="block truncate font-medium text-gray-700">{b.name || `Bill ${b.i + 1}`}</span>
                {onViewExisting ? (
                  <button type="button" onClick={() => onViewExisting(b.i)}
                    className="inline-flex items-center gap-1 text-[11px] text-gray-500 hover:text-blue-600">
                    <FiEye size={11} /> Already attached — view
                  </button>
                ) : (
                  <span className="block text-[11px] text-gray-400">Already attached</span>
                )}
              </span>
              <button
                type="button"
                onClick={() => removeKept(b.i)}
                disabled={disabled}
                aria-label={`Remove ${b.name || `bill ${b.i + 1}`}`}
                className="absolute right-1 top-1/2 -translate-y-1/2 grid w-7 h-7 place-items-center rounded-md text-gray-400 hover:bg-red-50 hover:text-red-600"
              >
                <FiX size={14} />
              </button>
            </div>
          ))}
          {files.map((f, idx) => (
            <div key={`new-${f.name}-${f.lastModified}-${idx}`} className={tile}>
              {previews[idx] ? (
                <img src={previews[idx]} alt="" className="h-9 w-9 shrink-0 rounded-md object-cover bg-gray-100" />
              ) : (
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-gray-100 text-gray-500">
                  <FiFileText size={15} />
                </span>
              )}
              <span className="min-w-0">
                <span className="block truncate font-medium text-gray-700">{f.name}</span>
                <span className="block text-[11px] text-gray-400">{kb(f.size)} · new</span>
              </span>
              <button
                type="button"
                onClick={() => removeNew(idx)}
                disabled={disabled}
                aria-label={`Remove ${f.name}`}
                className="absolute right-1 top-1/2 -translate-y-1/2 grid w-7 h-7 place-items-center rounded-md text-gray-400 hover:bg-red-50 hover:text-red-600"
              >
                <FiX size={14} />
              </button>
            </div>
          ))}
        </div>
      )}

      {hint && <p className="mt-1.5 text-xs text-gray-500">{hint}</p>}

      {camera && (
        <CameraCapture
          title={cameraTitle}
          fileName={fileName}
          multiple
          max={cameraRoom}
          onCapture={(file) => add([file])}
          onClose={() => setCamera(false)}
        />
      )}
    </div>
  );
}
