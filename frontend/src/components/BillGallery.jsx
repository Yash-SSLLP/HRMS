/**
 * BillGallery — every bill on one cashbook entry, in one window.
 *
 * NEW 2026-09-28, the other half of BillPicker: once an expense can carry
 * several bills, "View bill" cannot just open one. With a single bill the pages
 * keep doing exactly what they did (open it in a tab — see `openBill` below);
 * with more, this window lists them, photos drawn inline and PDFs one click
 * away. Each is fetched with the bearer token (`?i=` picks which), never by a
 * bare URL.
 */
import { useEffect, useState } from 'react';
import { toast } from 'react-toastify';
import { FiX, FiExternalLink, FiFileText } from 'react-icons/fi';
import api from '../api/client';
import { fetchImageObjectUrl } from '../api/download';

/** Browsers draw these; an iPhone's HEIC they do not. */
const drawable = (mime) => /^image\/(jpe?g|png|gif|webp|bmp)$/i.test(mime || '');

/** Open one protected bill in a new tab. */
export async function openBillInTab(path) {
  try {
    const res = await api.get(path, { responseType: 'blob' });
    const url = URL.createObjectURL(res.data);
    window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (err) {
    toast.error(err?.response?.status === 403 ? 'You cannot open this bill.' : 'Could not open the bill.');
  }
}

/**
 * "View bill" for any entry: one bill opens straight in a tab, as it always
 * did; several open the gallery. `showGallery` is the page's setter for it.
 */
export function openBill(entry, pathFor, showGallery) {
  const count = Number(entry?.attachmentCount) || (entry?.hasAttachment ? 1 : 0);
  if (count > 1 && showGallery) { showGallery(entry); return; }
  openBillInTab(pathFor(entry._id, 0));
}

function BillTile({ bill, n, total, path }) {
  const [src, setSrc] = useState(null);
  const [failed, setFailed] = useState(false);
  const image = drawable(bill.mime);

  useEffect(() => {
    if (!image) return undefined;
    let url = null;
    let live = true;
    fetchImageObjectUrl(path)
      .then((u) => { url = u; if (live) setSrc(u); else URL.revokeObjectURL(u); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; if (url) URL.revokeObjectURL(url); };
  }, [path, image]);

  return (
    <figure className="rounded-xl border border-gray-200 bg-gray-50 p-2">
      <figcaption className="mb-2 flex items-center justify-between gap-2 px-1 text-xs">
        <span className="min-w-0 truncate font-medium text-gray-700">
          Bill {n} of {total}{bill.name ? ` · ${bill.name}` : ''}
        </span>
        <button
          type="button"
          onClick={() => openBillInTab(path)}
          className="inline-flex shrink-0 items-center gap-1 text-gray-500 hover:text-blue-600"
        >
          <FiExternalLink size={12} /> Open
        </button>
      </figcaption>
      {image && src && !failed ? (
        <img src={src} alt={`Bill ${n}`} className="w-full max-h-[60vh] rounded-lg object-contain bg-white" />
      ) : image && !failed ? (
        <div className="h-40 animate-pulse rounded-lg bg-gray-100" />
      ) : (
        <button
          type="button"
          onClick={() => openBillInTab(path)}
          className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-gray-300 bg-white py-8 text-sm text-gray-600 hover:text-blue-600"
        >
          <FiFileText size={16} /> {/pdf/i.test(bill.mime || bill.name || '') ? 'Open the PDF' : 'Open this bill'}
        </button>
      )}
    </figure>
  );
}

/**
 * @param {object} props
 * @param {object|null} props.entry  the entry (with `attachments`), or null when closed
 * @param {(id: string, i: number) => string} props.pathFor  the API path of bill `i`
 * @param {() => void} props.onClose
 */
export default function BillGallery({ entry, pathFor, onClose }) {
  if (!entry) return null;
  const list = entry.attachments?.length
    ? entry.attachments
    : [{ i: 0, name: entry.attachmentName || '', mime: entry.attachmentMime || '' }];
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 px-4">
      <div className="w-full max-w-2xl rounded-xl bg-white p-5 shadow-lg max-h-[92vh] overflow-y-auto">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="card-title">{list.length} bills</h2>
            <p className="text-xs text-gray-500 truncate">
              {[entry.code, entry.purpose].filter(Boolean).join(' · ')}
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="topbar-icon-btn shrink-0">
            <FiX size={18} />
          </button>
        </div>
        <div className="space-y-3">
          {list.map((b, n) => (
            <BillTile key={b.i ?? n} bill={b} n={n + 1} total={list.length} path={pathFor(entry._id, b.i ?? n)} />
          ))}
        </div>
      </div>
    </div>
  );
}
