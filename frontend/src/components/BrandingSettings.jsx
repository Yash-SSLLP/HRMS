/**
 * BrandingSettings — the company logo and the CEO / MD / HR signature images
 * that get stamped onto every generated document (offer letter, appointment
 * letter, payslip).
 *
 * Lives under Admin → Email & Letter Templates because it answers the same
 * question that page does — "what do our outgoing documents look like?" — the
 * templates control the words, this controls the letterhead.
 *
 * SuperAdmin only; the API refuses anyone else, and the page hides the tab.
 * Images are stored in GridFS and read back through protected endpoints, hence
 * AuthImage rather than a plain <img src> (a bare img can't send the token).
 */
import { useEffect, useRef, useState } from 'react';
import { toast } from 'react-toastify';
import { FiUploadCloud, FiTrash2, FiSave } from 'react-icons/fi';
import api from '../api/client';
import AuthImage from './AuthImage';
import { confirmDialog } from './dialogs';

// Cache-buster so a freshly uploaded image replaces the previous one in the
// preview instead of showing the browser's cached copy of the same URL.
const withV = (url, v) => `${url}?v=${v}`;

function ImageDrop({ label, hint, url, version, onPick, onRemove, busy, hasImage }) {
  const inputRef = useRef(null);
  return (
    <div className="border border-gray-200 rounded-xl p-4">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <div className="text-sm font-semibold text-gray-800">{label}</div>
          {hint && <div className="text-xs text-gray-500 mt-0.5">{hint}</div>}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button" disabled={busy} onClick={() => inputRef.current?.click()}
            className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border border-gray-300 hover:bg-gray-50 disabled:opacity-50"
          >
            <FiUploadCloud /> {hasImage ? 'Replace' : 'Upload'}
          </button>
          {hasImage && (
            <button
              type="button" disabled={busy} onClick={onRemove}
              className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border border-red-200 text-red-700 hover:bg-red-50 disabled:opacity-50"
            >
              <FiTrash2 /> Remove
            </button>
          )}
        </div>
      </div>

      {/* A signature is usually dark ink on transparency, so the preview sits on
          a white tile rather than the page surface — otherwise it vanishes in
          dark mode, which is exactly when someone would think the upload failed. */}
      <div className="rounded-lg border border-dashed border-gray-300 bg-white flex items-center justify-center h-24 overflow-hidden">
        {hasImage ? (
          <AuthImage
            url={withV(url, version)}
            alt={label}
            className="max-h-20 max-w-full object-contain"
            fallback={<span className="text-xs text-gray-400">Preview unavailable</span>}
          />
        ) : (
          <span className="text-xs text-gray-400">Nothing uploaded — the built-in default is used</span>
        )}
      </div>

      <input
        ref={inputRef} type="file" accept="image/*" className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) onPick(f); e.target.value = ''; }}
      />
    </div>
  );
}

export default function BrandingSettings() {
  const [branding, setBranding] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [version, setVersion] = useState(0);
  // Local edits to the printed name/title under each signature.
  const [captions, setCaptions] = useState({});

  const load = async () => {
    setLoading(true); setError('');
    try {
      const { data } = await api.get('/admin/org-settings');
      setBranding(data.branding);
      const c = {};
      (data.branding?.signatures || []).forEach((s) => {
        c[s.key] = { signatoryName: s.signatoryName || '', signatoryTitle: s.signatoryTitle || '' };
      });
      setCaptions(c);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load branding settings');
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const applyResult = (data) => {
    setBranding(data.branding);
    setVersion((v) => v + 1);   // force the previews to refetch
  };

  const uploadLogo = async (file) => {
    setBusy('logo');
    try {
      const fd = new FormData(); fd.append('image', file);
      const { data } = await api.post('/admin/org-settings/logo', fd);
      applyResult(data); toast.success('Company logo updated');
    } catch (err) { toast.error(err.response?.data?.message || 'Upload failed'); }
    finally { setBusy(''); }
  };

  const removeLogo = async () => {
    if (!(await confirmDialog({ title: 'Remove company logo?', message: 'Letters and payslips will fall back to the built-in logo.' }))) return;
    setBusy('logo');
    try {
      const { data } = await api.delete('/admin/org-settings/logo');
      applyResult(data); toast.success('Company logo removed');
    } catch (err) { toast.error(err.response?.data?.message || 'Could not remove'); }
    finally { setBusy(''); }
  };

  const uploadSignature = async (key, file) => {
    setBusy(key);
    try {
      const fd = new FormData();
      fd.append('image', file);
      // Send the captions alongside so a first upload persists them in one call.
      fd.append('signatoryName', captions[key]?.signatoryName || '');
      fd.append('signatoryTitle', captions[key]?.signatoryTitle || '');
      const { data } = await api.post(`/admin/org-settings/signature/${key}`, fd);
      applyResult(data); toast.success('Signature updated');
    } catch (err) { toast.error(err.response?.data?.message || 'Upload failed'); }
    finally { setBusy(''); }
  };

  const saveCaptions = async (key) => {
    setBusy(key);
    try {
      // No file part: the server keeps the existing image and updates the text.
      const fd = new FormData();
      fd.append('signatoryName', captions[key]?.signatoryName || '');
      fd.append('signatoryTitle', captions[key]?.signatoryTitle || '');
      const { data } = await api.post(`/admin/org-settings/signature/${key}`, fd);
      applyResult(data); toast.success('Signature details saved');
    } catch (err) { toast.error(err.response?.data?.message || 'Could not save'); }
    finally { setBusy(''); }
  };

  const removeSignature = async (key, label) => {
    if (!(await confirmDialog({ title: `Remove the ${label} signature?`, message: 'Letters signed by this person will print the ruled signature line only.' }))) return;
    setBusy(key);
    try {
      const { data } = await api.delete(`/admin/org-settings/signature/${key}`);
      applyResult(data); toast.success('Signature removed');
    } catch (err) { toast.error(err.response?.data?.message || 'Could not remove'); }
    finally { setBusy(''); }
  };

  if (loading) {
    return (
      <div className="bg-white shadow rounded-lg p-6 space-y-2.5">
        <div className="skeleton h-4 rounded" />
        <div className="skeleton h-4 rounded w-5/6" />
        <div className="skeleton h-4 rounded w-2/3" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {error && (
        <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>
      )}

      <p className="text-sm text-gray-500 max-w-4xl">
        These images are stamped onto every document the system generates — offer letters, appointment
        letters and payslips. A transparent PNG works best; anything you upload here replaces the built-in
        default everywhere at once, with no redeploy.
      </p>

      <div className="bg-white shadow rounded-lg p-4">
        <ImageDrop
          label="Company logo"
          hint="Top-left of every letterhead. Wide/landscape art reproduces best."
          url="/admin/org-settings/logo"
          version={version}
          hasImage={!!branding?.hasLogo}
          busy={busy === 'logo'}
          onPick={uploadLogo}
          onRemove={removeLogo}
        />
      </div>

      <div className="bg-white shadow rounded-lg p-4">
        <div className="text-sm font-semibold text-gray-800 mb-1">Authorised signatures</div>
        <p className="text-xs text-gray-500 mb-3">
          Printed above the name on letters. Upload a signature scanned or drawn on a white/transparent
          background — it is placed as-is, so crop out any surrounding whitespace.
        </p>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
          {(branding?.signatures || []).map((s) => (
            <div key={s.key} className="space-y-2">
              <ImageDrop
                label={s.label}
                url={`/admin/org-settings/signature/${s.key}`}
                version={version}
                hasImage={!!s.hasImage}
                busy={busy === s.key}
                onPick={(f) => uploadSignature(s.key, f)}
                onRemove={() => removeSignature(s.key, s.label)}
              />
              <div className="px-1 space-y-2">
                <input
                  value={captions[s.key]?.signatoryName ?? ''}
                  onChange={(e) => setCaptions((c) => ({ ...c, [s.key]: { ...c[s.key], signatoryName: e.target.value } }))}
                  placeholder="Name printed under the signature"
                  className="block w-full border rounded-lg px-3 py-2 text-sm"
                />
                <input
                  value={captions[s.key]?.signatoryTitle ?? ''}
                  onChange={(e) => setCaptions((c) => ({ ...c, [s.key]: { ...c[s.key], signatoryTitle: e.target.value } }))}
                  placeholder={`Title (defaults to "${s.label}")`}
                  className="block w-full border rounded-lg px-3 py-2 text-sm"
                />
                <button
                  type="button" disabled={busy === s.key || !s.hasImage}
                  onClick={() => saveCaptions(s.key)}
                  title={s.hasImage ? '' : 'Upload a signature image first'}
                  className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg bg-gray-900 text-white hover:bg-gray-700 disabled:opacity-50"
                >
                  <FiSave /> Save details
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
