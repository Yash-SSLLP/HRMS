import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import api, { getBaseURL } from '../api/client';
import { COMPANY_NAME } from '../config/company';
import BrandLockup from '../components/BrandLockup';

/**
 * LetterDownload — public (no-login) page, route /letters/:token.
 * A candidate/employee opens their offer or appointment letter from the
 * tokenised link emailed to them.
 *
 * The PDF is rendered from the API URL DIRECTLY rather than fetched as a blob.
 * An iframe/anchor navigation is not subject to CORS, whereas the old XHR was —
 * so whenever the API's CORS_ORIGIN didn't match the site the candidate had
 * opened, every letter failed with the generic "could not load" message. The
 * recipient is external and unauthenticated, so the page has to work without
 * depending on origin configuration at all.
 *
 * A probe request still runs, but only to turn a genuine 404 into a friendly
 * message. If the probe fails for any other reason the direct render proceeds
 * regardless — the probe must never be what blocks the letter.
 */
export default function LetterDownload() {
  const { token } = useParams();
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const base = await getBaseURL();
        if (!cancelled) setUrl(`${String(base).replace(/\/+$/, '')}/recruitment/letters/${token}`);
      } catch {
        /* base URL unresolvable — the probe below still decides what to show */
      }
      // Probe purely to distinguish "bad token" from "everything else".
      try {
        await api.get(`/recruitment/letters/${token}`, { responseType: 'blob' });
      } catch (err) {
        if (!cancelled && err.response?.status === 404) {
          setError('This letter link is invalid or has expired.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  return (
    <div className="min-h-full flex items-center justify-center bg-gradient-to-br from-gray-100 via-gray-50 to-blue-50 dark:from-gray-900 dark:via-gray-900 dark:to-gray-800 px-4 py-10">
      <div className="w-full max-w-2xl bg-white shadow-lg rounded-2xl p-6 sm:p-8 border border-gray-100">
        <div className="flex flex-col items-center text-center mb-5">
          <BrandLockup variant="stacked" />
          <h1 className="text-xl font-bold text-gray-900 mt-4">Your letter from {COMPANY_NAME}</h1>
        </div>

        {loading ? (
          <p className="text-center text-gray-500">Loading…</p>
        ) : error ? (
          <div className="text-center text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">{error}</div>
        ) : (
          <>
            <div className="flex flex-wrap justify-center gap-2 mb-4">
              {/* Plain anchors, not a blob click — the server's Content-Disposition
                  supplies the filename, and this keeps working on mobile mail
                  browsers that block programmatic blob downloads. */}
              <a href={url} download
                className="bg-gray-900 text-white px-5 py-2.5 rounded-lg font-medium hover:bg-gray-700">
                ⬇ Download PDF
              </a>
              <a href={url} target="_blank" rel="noreferrer"
                className="border border-gray-300 text-gray-700 px-5 py-2.5 rounded-lg font-medium hover:bg-gray-50">
                Open in new tab
              </a>
            </div>
            {/* Some in-app mail browsers refuse to render a PDF in an iframe;
                the buttons above are the guaranteed path, this is the nicety. */}
            <iframe title="Letter" src={url} className="w-full h-[70vh] rounded-lg border border-gray-200" />
          </>
        )}
      </div>
    </div>
  );
}
