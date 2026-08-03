/**
 * DocPreviewModal — look at a stored document without leaving the page.
 *
 * "View" used to trigger a download, so verifying a set of documents meant
 * saving ten files, opening each in another app, then coming back to press
 * Verify. The document now opens over the page: images and PDFs render inline,
 * and anything the browser can't show falls back to a download prompt.
 *
 * The file is fetched through the axios instance so the Bearer token is
 * attached (these routes are protected, and PII categories are HR-only), which
 * is why it is a blob rather than a plain <img src="/api/…">.
 *
 * Used by pages/AdminEmployeeDetail.jsx and pages/AdminDocuments.jsx.
 */
import { useEffect, useState } from 'react';
import { FiDownload, FiExternalLink, FiX } from 'react-icons/fi';
import api from '../api/client';

const isImageDoc = (mime, name) => (mime || '').startsWith('image/') || /\.(png|jpe?g|webp|gif|heic)$/i.test(name || '');
const isPdfDoc = (mime, name) => (mime || '') === 'application/pdf' || /\.pdf$/i.test(name || '');

const prettySize = (bytes) => {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

/**
 * @param {{_id: string, fileName?: string, category?: string, mime?: string, sizeBytes?: number, status?: string}} doc
 * @param {string} [url] - API path to fetch; defaults to the employee-document route
 * @param {() => void} onClose
 */
export default function DocPreviewModal({ doc, url, onClose }) {
  const [blobUrl, setBlobUrl] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const fileName = doc?.fileName || 'document';
  const path = url || `/documents/${doc?._id}/download`;
  const image = isImageDoc(doc?.mime, fileName);
  const pdf = isPdfDoc(doc?.mime, fileName);

  useEffect(() => {
    if (!doc?._id) return undefined;
    let revoked = false;
    let made = null;
    setLoading(true); setError('');
    api.get(path, { responseType: 'blob' })
      .then((res) => {
        if (revoked) return;
        made = URL.createObjectURL(res.data);
        setBlobUrl(made);
      })
      .catch((err) => setError(err.response?.data?.message || 'Could not open this document'))
      .finally(() => setLoading(false));
    return () => { revoked = true; if (made) URL.revokeObjectURL(made); };
  }, [doc?._id, path]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Download the blob already in hand rather than fetching the file twice.
  const download = () => {
    if (!blobUrl) return;
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  if (!doc) return null;

  return (
    <div className="fixed inset-0 z-[60] bg-black/70 flex items-center justify-center p-4" onClick={onClose}>
      <div className="docfield-preview w-full max-w-4xl max-h-[92vh] rounded-xl overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-4 py-3 docfield-preview-bar">
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold">{fileName}</span>
            <span className="block text-[11px] docfield-meta">
              {doc.category}{doc.sizeBytes ? ` · ${prettySize(doc.sizeBytes)}` : ''}{doc.status ? ` · ${doc.status}` : ''}
            </span>
          </span>
          <button type="button" onClick={download} disabled={!blobUrl}
            className="shrink-0 inline-flex items-center gap-1.5 text-xs font-semibold docfield-action px-2.5 py-1.5 rounded-md disabled:opacity-50">
            <FiDownload size={13} /> Download
          </button>
          {blobUrl && (
            <a href={blobUrl} target="_blank" rel="noreferrer"
              className="shrink-0 inline-flex items-center gap-1.5 text-xs font-semibold docfield-action px-2.5 py-1.5 rounded-md">
              <FiExternalLink size={13} /> New tab
            </a>
          )}
          <button type="button" onClick={onClose} aria-label="Close preview" className="docfield-remove p-1 rounded-md shrink-0">
            <FiX size={18} />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-auto flex items-center justify-center p-3">
          {loading && <p className="text-sm docfield-meta py-16">Opening…</p>}
          {!loading && error && <p className="text-sm text-red-600 py-16">{error}</p>}
          {!loading && !error && blobUrl && (
            image ? (
              <img src={blobUrl} alt={fileName} className="max-w-full max-h-[75vh] object-contain rounded-lg" />
            ) : pdf ? (
              <iframe src={blobUrl} title={fileName} className="w-full h-[75vh] rounded-lg border-0 bg-white" />
            ) : (
              // Word documents and the like: the browser can't render them, so
              // say so plainly instead of showing an empty frame.
              <div className="text-center py-16">
                <p className="text-sm docfield-meta">This file type can’t be shown here.</p>
                <button type="button" onClick={download}
                  className="mt-3 inline-flex items-center gap-1.5 text-xs font-semibold docfield-action px-3 py-2 rounded-md">
                  <FiDownload size={13} /> Download {fileName}
                </button>
              </div>
            )
          )}
        </div>
      </div>
    </div>
  );
}
