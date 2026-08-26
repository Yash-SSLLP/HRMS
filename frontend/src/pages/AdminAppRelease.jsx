/**
 * AdminAppRelease — SuperAdmin-only view of the Android build every phone is
 * offered, and (where the server keeps APKs itself) the place to publish a new
 * one without any CLI.
 *
 * The mobile app is sideloaded, so nothing tells a phone a new build exists: it
 * asks the backend, and this is the record it asks about. There is exactly one —
 * publishing REPLACES the previous build, file included.
 *
 * WHY THE UPLOAD BOX IS SOMETIMES ABSENT. Where the APK physically lives depends
 * on the server's APP_RELEASE_STORE:
 *
 *   repo    the APK is committed to the repository's "Mobile App" folder and
 *           arrives by `git pull` on deploy. Git is the publisher; this page is
 *           then a read-only view of what the server is currently serving.
 *   disk    the server keeps the file, so it can be uploaded from here.
 *   github  the server keeps only a pointer to a release asset, and the ~70 MB
 *           deliberately never travels through the API — publishing then happens
 *           from CI or `npm run release`, which put the file on GitHub directly.
 *
 * So the page shows what the server can actually accept rather than offering an
 * upload that would be refused.
 */
import { useEffect, useState } from 'react';
import api from '../api/client';
import { useAuthStore } from '../store/authStore';
import PageHeader from '../components/PageHeader';
import { formatDateTime12 } from '../utils/time';

const mb = (bytes) => `${(Number(bytes || 0) / 1e6).toFixed(1)} MB`;

// CI and `npm run bump` name the file hrms-<versionName>-<versionCode>.apk, so a
// hand-published build can fill its own version in and the two cannot drift.
const NAME_RE = /^hrms-(\d+\.\d+\.\d+)-(\d+)\.apk$/i;

export default function AdminAppRelease() {
  const me = useAuthStore((s) => s.user);

  const [release, setRelease] = useState(null);
  const [store, setStore] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [file, setFile] = useState(null);
  const [versionName, setVersionName] = useState('');
  const [versionCode, setVersionCode] = useState('');
  const [notes, setNotes] = useState('');
  const [progress, setProgress] = useState(-1);
  const [done, setDone] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/app/release');
      setRelease(data.release);
      setStore(data.store);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not load the current build.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (me?.role !== 'SuperAdmin') return;
    load();
  }, [me]);

  if (me?.role !== 'SuperAdmin') {
    return (
      <div>
        <PageHeader title="App Release" />
        <div className="bg-white shadow rounded-lg p-8 text-center text-gray-500">
          This tool isn&apos;t available for your account.
        </div>
      </div>
    );
  }

  /** Fill the version fields from the file name, so they cannot disagree with it. */
  const pickFile = (f) => {
    setFile(f);
    setDone('');
    const m = f && NAME_RE.exec(f.name);
    if (m) {
      setVersionName(m[1]);
      setVersionCode(m[2]);
    }
  };

  const publish = async (e) => {
    e.preventDefault();
    setError('');
    setDone('');
    if (!file) { setError('Choose the .apk file first.'); return; }

    const fd = new FormData();
    fd.append('versionName', versionName.trim());
    fd.append('versionCode', String(versionCode).trim());
    fd.append('notes', notes.trim());
    fd.append('file', file);

    setProgress(0);
    try {
      await api.post('/app/publish', fd, {
        // ~70 MB over an office connection takes minutes; the default timeout
        // would abort a perfectly healthy upload partway through.
        timeout: 0,
        onUploadProgress: (p) => {
          if (p.total) setProgress(Math.min(99, Math.round((p.loaded / p.total) * 100)));
        },
      });
      setProgress(100);
      setDone(`Published ${versionName} (versionCode ${versionCode}). Phones are offered it on their next check.`);
      setFile(null);
      setNotes('');
      await load();
    } catch (err) {
      setError(err.response?.data?.message || 'The publish was refused.');
    } finally {
      setProgress(-1);
    }
  };

  return (
    <div>
      <PageHeader title="App Release" subtitle="The Android build every phone is offered" />

      {error && <div className="mb-4 rounded-lg bg-red-50 text-red-700 px-4 py-3 text-sm">{error}</div>}
      {done && <div className="mb-4 rounded-lg bg-green-50 text-green-700 px-4 py-3 text-sm">{done}</div>}

      <div className="bg-white shadow rounded-lg p-6 mb-6">
        <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-4">Currently published</h2>
        {loading ? (
          <div className="text-gray-500">Loading…</div>
        ) : !release ? (
          <div className="text-gray-500">
            Nothing has been published yet, so no phone is being offered an update.
          </div>
        ) : (
          <dl className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <div>
              <dt className="text-gray-500">Version</dt>
              <dd className="font-semibold text-gray-900">{release.versionName}</dd>
            </div>
            <div>
              {/* The number that actually decides whether a phone is offered the
                  update — versionName is only ever displayed. */}
              <dt className="text-gray-500">versionCode</dt>
              <dd className="font-semibold text-gray-900">{release.versionCode}</dd>
            </div>
            <div>
              <dt className="text-gray-500">Size</dt>
              <dd className="font-semibold text-gray-900">{mb(release.size)}</dd>
            </div>
            <div>
              <dt className="text-gray-500">Published</dt>
              <dd className="font-semibold text-gray-900">{formatDateTime12(release.createdAt || release.publishedAt)}</dd>
            </div>
            {release.store !== 'repo' && (
              <div className="col-span-2">
                <dt className="text-gray-500">By</dt>
                <dd className="text-gray-900">
                  {release.publishedVia === 'ci'
                    ? 'CI (a push to the mobile repo)'
                    : release.publishedBy?.name || 'an operator'}
                </dd>
              </div>
            )}
            <div className="col-span-2">
              <dt className="text-gray-500">Stored</dt>
              <dd className="text-gray-900">
                {release.store === 'repo'
                  ? `in the repository — Mobile App/${release.fileName}`
                  : release.store === 'disk'
                    ? `on this server (${release.fileName})`
                    : `on ${release.githubRepo} (${release.githubTag})`}
              </dd>
            </div>
            {release.notes && (
              <div className="col-span-2 md:col-span-4">
                <dt className="text-gray-500">Notes</dt>
                <dd className="text-gray-900 whitespace-pre-wrap">{release.notes}</dd>
              </div>
            )}
          </dl>
        )}
      </div>

      {!loading && store?.mode === 'upload' && (
        <form onSubmit={publish} className="bg-white shadow rounded-lg p-6">
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-1">Publish a new build</h2>
          <p className="text-sm text-gray-500 mb-4">
            This replaces the current build and its file. The version must be higher than the
            published one — Android refuses to install anything lower over it.
          </p>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="md:col-span-2">
              <label className="block text-sm text-gray-700 mb-1" htmlFor="apk">APK file</label>
              <input
                id="apk"
                type="file"
                accept=".apk"
                onChange={(e) => pickFile(e.target.files?.[0] || null)}
                className="block w-full text-sm text-gray-700"
              />
              {file && <p className="mt-1 text-xs text-gray-500">{file.name} — {mb(file.size)}</p>}
            </div>

            <div>
              <label className="block text-sm text-gray-700 mb-1" htmlFor="vname">Version name</label>
              <input
                id="vname"
                value={versionName}
                onChange={(e) => setVersionName(e.target.value)}
                placeholder="2.2.3"
                className="w-full border rounded-lg px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-700 mb-1" htmlFor="vcode">Version code</label>
              <input
                id="vcode"
                type="number"
                value={versionCode}
                onChange={(e) => setVersionCode(e.target.value)}
                placeholder="49"
                className="w-full border rounded-lg px-3 py-2 text-sm"
              />
            </div>

            <div className="md:col-span-2">
              <label className="block text-sm text-gray-700 mb-1" htmlFor="notes">What changed (shown in the app)</label>
              <textarea
                id="notes"
                rows={3}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                className="w-full border rounded-lg px-3 py-2 text-sm"
              />
            </div>
          </div>

          {progress >= 0 && (
            <div className="mt-4">
              <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
                <div className="h-2 bg-blue-600 transition-all" style={{ width: `${progress}%` }} />
              </div>
              <p className="mt-1 text-xs text-gray-500">Uploading… {progress}%</p>
            </div>
          )}

          <button
            type="submit"
            disabled={progress >= 0}
            className="mt-5 px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium disabled:opacity-50"
          >
            {progress >= 0 ? 'Publishing…' : 'Publish'}
          </button>
        </form>
      )}

      {!loading && store?.mode === 'repo' && (
        <div className="bg-white shadow rounded-lg p-6 text-sm text-gray-600">
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-2">Publishing</h2>
          <p>
            This server serves whatever APK sits in the repository&apos;s
            {' '}<code className="bg-gray-100 px-1 rounded">Mobile App</code> folder
            {store.dir && <> (<code className="bg-gray-100 px-1 rounded">{store.dir}</code>)</>}, so
            <strong> git is the publisher</strong> — there is nothing to upload here. To release a new build:
            bump the version, build the APK, drop it in that folder as
            {' '}<code className="bg-gray-100 px-1 rounded">hrms-&lt;version&gt;-&lt;code&gt;.apk</code>, commit, push,
            and deploy. Phones are offered it on their next check.
          </p>
        </div>
      )}

      {!loading && store?.mode === 'reference' && (
        <div className="bg-white shadow rounded-lg p-6 text-sm text-gray-600">
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-2">Publishing</h2>
          <p>
            This server keeps only a pointer to the APK — the file itself lives on
            {' '}<span className="font-medium text-gray-900">{store.repo || 'the mobile repository'}</span>, so a ~70 MB
            upload never has to travel through the API. New builds are published by pushing a version
            bump to the mobile repository, or by running <code className="bg-gray-100 px-1 rounded">npm run release -- --publish</code> there.
          </p>
        </div>
      )}

      {!loading && store && !store.configured && (
        <div className="mt-4 rounded-lg bg-amber-50 text-amber-800 px-4 py-3 text-sm">
          The release store is not fully configured on the server, so publishing will be refused.
        </div>
      )}
    </div>
  );
}
