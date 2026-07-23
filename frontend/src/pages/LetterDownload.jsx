import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import api from '../api/client';
import { COMPANY_NAME, COMPANY_LOGO } from '../config/company';

/**
 * LetterDownload — public (no-login) page, route /letters/:token.
 * A candidate/employee opens their offer or appointment letter from the
 * tokenised link emailed to them. Fetches the PDF as a blob via
 * GET /recruitment/letters/:token and renders it inline + a download button.
 */
export default function LetterDownload() {
  const { token } = useParams();
  const [url, setUrl] = useState('');
  const [name, setName] = useState('letter.pdf');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  // Fetch the letter as a blob, derive the filename from Content-Disposition,
  // and build an object URL for the iframe/download (revoked on unmount).
  useEffect(() => {
    let objUrl;
    (async () => {
      try {
        const res = await api.get(`/recruitment/letters/${token}`, { responseType: 'blob' });
        const cd = res.headers['content-disposition'] || '';
        const m = /filename="?([^";]+)"?/i.exec(cd);
        if (m) setName(m[1]);
        objUrl = URL.createObjectURL(res.data);
        setUrl(objUrl);
      } catch (err) {
        setError(err.response?.status === 404
          ? 'This letter link is invalid or has expired.'
          : 'Sorry, we could not load this letter. Please try again later.');
      } finally { setLoading(false); }
    })();
    return () => { if (objUrl) URL.revokeObjectURL(objUrl); };
  }, [token]);

  const download = () => {
    if (!url) return;
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
  };

  return (
    <div className="min-h-full flex items-center justify-center bg-gradient-to-br from-gray-100 via-gray-50 to-blue-50 px-4 py-10">
      <div className="w-full max-w-2xl bg-white shadow-lg rounded-2xl p-6 sm:p-8 border border-gray-100">
        <div className="flex flex-col items-center text-center mb-5">
          <img src={COMPANY_LOGO} alt={COMPANY_NAME} className="h-12 w-auto mb-3" />
          <h1 className="text-xl font-bold text-gray-900">Your letter from {COMPANY_NAME}</h1>
        </div>

        {loading ? (
          <p className="text-center text-gray-500">Loading…</p>
        ) : error ? (
          <div className="text-center text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">{error}</div>
        ) : (
          <>
            <div className="flex justify-center mb-4">
              <button onClick={download} className="bg-gray-900 text-white px-5 py-2.5 rounded-lg font-medium hover:bg-gray-700">
                ⬇ Download PDF
              </button>
            </div>
            <iframe title="Letter" src={url} className="w-full h-[70vh] rounded-lg border border-gray-200" />
          </>
        )}
      </div>
    </div>
  );
}
