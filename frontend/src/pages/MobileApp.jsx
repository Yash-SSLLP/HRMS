/**
 * MobileApp — where anyone gets the Android app, and the current build.
 *
 * The app is SIDELOADED, not on the Play Store, so there is no store page to
 * send people to and nothing on a phone that discovers a new build on its own.
 * Until now the APK could only be reached by an admin opening Settings → App
 * Release, or by someone who already had the app installed and got the update
 * push — which left a new joiner with no way to install it at all.
 *
 * Both endpoints behind this page are PUBLIC by design (see
 * backend/routes/appReleaseRoutes.js), which is why the same component also
 * serves the signed-out route: the link can go in a welcome email to somebody
 * who has not signed in yet.
 *
 * The download is a plain <a href> to the API, deliberately NOT the axios
 * `downloadFile` helper: that reads the whole response into a Blob, and this
 * file is ~70 MB. A direct link lets the browser stream it to disk, show real
 * progress, and resume — and needs no token, because the route is public.
 */
import { useEffect, useState } from 'react';
import { FiDownload, FiSmartphone, FiCopy, FiCheck, FiAlertTriangle } from 'react-icons/fi';
import api, { getBaseURL } from '../api/client';
import PageHeader from '../components/PageHeader';
import { formatDateTime12 } from '../utils/time';

const mb = (bytes) => (bytes ? `${(Number(bytes) / 1e6).toFixed(1)} MB` : null);

export default function MobileApp({ standalone = false }) {
  const [release, setRelease] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [downloadUrl, setDownloadUrl] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [{ data }, base] = await Promise.all([api.get('/app/latest'), getBaseURL()]);
        if (!alive) return;
        setRelease(data.release || null);
        setDownloadUrl(`${base}/app/download`);
      } catch (err) {
        if (alive) setError(err.response?.data?.message || 'Could not load the app version.');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(downloadUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard blocked — the field below is selectable, which is the fallback */
    }
  };

  const body = (
    <div className="max-w-2xl">
      {error && (
        <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>
      )}

      <div className="bg-white shadow rounded-lg p-5">
        <div className="flex items-start gap-4">
          <div className="shrink-0 w-12 h-12 rounded-xl accent-bg text-white flex items-center justify-center">
            <FiSmartphone size={24} aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="card-title">HRMS for Android</h2>
            {loading ? (
              <p className="text-sm text-gray-500 mt-1">Checking the latest build…</p>
            ) : release ? (
              <p className="text-sm text-gray-500 mt-1">
                Version <span className="font-semibold text-gray-800">{release.versionName}</span>
                {release.versionCode ? ` (build ${release.versionCode})` : ''}
                {mb(release.size) ? ` · ${mb(release.size)}` : ''}
                {release.publishedAt ? ` · published ${formatDateTime12(release.publishedAt)}` : ''}
              </p>
            ) : (
              <p className="text-sm text-gray-500 mt-1">No build has been published yet.</p>
            )}
          </div>
        </div>

        {/* Release notes, when whoever published the build wrote any. */}
        {release?.notes ? (
          <div className="mt-4 border-t pt-3">
            <div className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-1">What&apos;s new</div>
            <p className="text-sm text-gray-700 whitespace-pre-wrap">{release.notes}</p>
          </div>
        ) : null}

        {release && (
          <>
            <div className="mt-5 flex flex-wrap items-center gap-3">
              <a
                href={downloadUrl || undefined}
                className="inline-flex items-center gap-2 px-4 py-2 bg-gray-900 text-white rounded-lg hover:bg-gray-700 text-sm font-semibold"
              >
                <FiDownload size={16} aria-hidden="true" />
                Download APK
              </a>
              <span className="text-xs text-gray-500">Android only · installs alongside nothing else</span>
            </div>

            {/* The download is on a laptop far more often than on the phone that
                needs it, so the URL is offered to copy. It needs no sign-in. */}
            <div className="mt-5 border-t pt-4">
              <div className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-1.5">
                Installing on your phone
              </div>
              <p className="text-sm text-gray-600">
                Open this link on the phone itself — no sign-in needed to download:
              </p>
              <div className="mt-2 flex gap-2">
                <input
                  readOnly
                  value={downloadUrl}
                  onFocus={(e) => e.target.select()}
                  className="flex-1 min-w-0 border rounded-lg px-2 py-1.5 text-xs bg-gray-50 font-mono"
                />
                <button
                  type="button"
                  onClick={copyLink}
                  className="shrink-0 inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-gray-300 bg-white hover:bg-gray-50"
                >
                  {copied ? <FiCheck size={13} aria-hidden="true" /> : <FiCopy size={13} aria-hidden="true" />}
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
              <ol className="mt-3 text-sm text-gray-600 list-decimal pl-5 space-y-1">
                <li>Open the link on your Android phone and let the download finish.</li>
                <li>Tap the downloaded file. Android will ask whether to allow installing from your browser — allow it.</li>
                <li>Tap <strong>Install</strong>, then sign in with your employee code.</li>
              </ol>
              <p className="mt-3 text-xs text-gray-500 flex items-start gap-1.5">
                <FiAlertTriangle size={13} className="shrink-0 mt-0.5" aria-hidden="true" />
                Updating: install this over your existing app — your data stays. There is no iPhone build.
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  );

  // Signed-out visitors get their own frame; inside the portal the sidebar and
  // top bar are already there.
  if (standalone) {
    return (
      <div className="min-h-screen bg-gray-50 py-10 px-4">
        <div className="max-w-2xl mx-auto">
          <h1 className="text-2xl font-bold text-gray-900 mb-1">Get the HRMS app</h1>
          <p className="text-sm text-gray-500 mb-6">Android · install and sign in with your employee code</p>
          {body}
        </div>
      </div>
    );
  }

  return (
    <div>
      <PageHeader title="Mobile App" subtitle="Download the Android app, or update to the latest build" />
      {body}
    </div>
  );
}
