import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import api, { getBaseURL } from '../api/client';
import { COMPANY_NAME } from '../config/company';
import BrandLockup from '../components/BrandLockup';

/**
 * PublicBill — public (no-login) page, route /bill/:id/:sig.
 *
 * WHERE THE LINK COMES FROM. A cashbook statement PDF prints each expense with
 * a 34pt thumbnail of its bill. That is enough to see that a bill exists and
 * nowhere near enough to check a figure against it, so every row that has one
 * carries a link here — the thumbnail itself, or the words "View bill" on the
 * rows whose bill could not be drawn (a scanned PDF invoice, or a bill past the
 * report's embedding cap).
 *
 * WHY NO LOGIN. A PDF viewer opens a link in a plain browser tab: there is
 * nowhere to put a bearer header, and putting the reader's token into the
 * document would hand their whole session to anyone the file is forwarded to.
 * The id is HMAC-signed by the server instead (backend/utils/signedLink.js) and
 * the signature IS the access check. It grants exactly one thing — reading this
 * one bill — to whoever holds a document that already has the same bill printed
 * on the page above it.
 *
 * The image is rendered from the API URL DIRECTLY rather than fetched as a
 * blob, for the same reason LetterDownload does it: an <img>/<iframe> load is
 * not subject to CORS, whereas an XHR is, so the page cannot be broken by the
 * API's CORS_ORIGIN disagreeing with wherever the reader opened it. The meta
 * request is an XHR and MAY fail that way — so it only ever decorates the page
 * with what the bill belongs to, and never gates showing the bill itself.
 */
export default function PublicBill() {
  const { id, sig } = useParams();
  const [url, setUrl] = useState('');
  const [meta, setMeta] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const base = await getBaseURL();
        if (!cancelled) setUrl(`${String(base).replace(/\/+$/, '')}/khata/public/receipt/${id}/${sig}`);
      } catch {
        /* base URL unresolvable — the meta probe below decides what to show */
      }
      try {
        const res = await api.get(`/khata/public/receipt/${id}/${sig}/meta`);
        if (!cancelled) setMeta(res.data);
      } catch (err) {
        // A dead link is the one failure worth stopping on: showing an empty
        // frame under a heading is worse than saying the link is no good.
        // Anything else (offline, CORS, a slow API) leaves the bill to load on
        // its own.
        if (!cancelled && err.response?.status === 404) {
          setError('This bill link is invalid or has expired.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [id, sig]);

  // A photographed bill is the overwhelmingly common case and an <img> is the
  // right element for it — it scales to the page and the browser's own zoom and
  // save-image work on it. A PDF invoice needs a viewer, so it gets the iframe.
  const isPdf = String(meta?.mime || '').includes('pdf')
    || /\.pdf$/i.test(String(meta?.fileName || ''));

  const money = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const fmtDate = (d) => (d
    ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
    : '');

  return (
    <div className="min-h-full flex items-center justify-center bg-gradient-to-br from-gray-100 via-gray-50 to-blue-50 dark:from-gray-900 dark:via-gray-900 dark:to-gray-800 px-4 py-10">
      <div className="w-full max-w-3xl bg-white shadow-lg rounded-2xl p-6 sm:p-8 border border-gray-100">
        <div className="flex flex-col items-center text-center mb-5">
          <BrandLockup variant="stacked" />
          <h1 className="text-xl font-bold text-gray-900 mt-4">Bill from {COMPANY_NAME}</h1>
        </div>

        {loading ? (
          <p className="text-center text-gray-500">Loading…</p>
        ) : error ? (
          <div className="text-center text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">
            {error}
          </div>
        ) : (
          <>
            {/* Which row this bill belongs to — the same facts already printed
                beside the thumbnail in the document the reader came from, so the
                two can be matched up without going back to the PDF. */}
            {meta && (
              <div className="mb-4 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3">
                <p className="font-medium text-gray-900">
                  {money(meta.amount)}
                  {meta.purpose ? ` · ${meta.purpose}` : ''}
                </p>
                <p className="text-xs text-gray-500 mt-0.5">
                  {[
                    fmtDate(meta.date),
                    meta.khataName,
                    meta.employeeName,
                    meta.code,
                  ].filter(Boolean).join(' · ')}
                </p>
              </div>
            )}

            <div className="flex flex-wrap justify-center gap-2 mb-4">
              <a href={url} target="_blank" rel="noreferrer"
                className="bg-gray-900 text-white px-5 py-2.5 rounded-lg font-medium hover:bg-gray-700">
                Open full size
              </a>
              {/* Plain anchor, not a blob click — the server's
                  Content-Disposition supplies the filename, and this keeps
                  working in mail browsers that block programmatic downloads. */}
              <a href={url} download={meta?.fileName || ''}
                className="border border-gray-300 text-gray-700 px-5 py-2.5 rounded-lg font-medium hover:bg-gray-50">
                ⬇ Download
              </a>
            </div>

            {isPdf ? (
              <iframe title="Bill" src={url}
                className="w-full h-[70vh] rounded-lg border border-gray-200" />
            ) : (
              <img src={url} alt={meta?.purpose || 'Bill'}
                className="w-full max-h-[75vh] object-contain rounded-lg border border-gray-200 bg-gray-50" />
            )}
          </>
        )}
      </div>
    </div>
  );
}
