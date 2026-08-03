/**
 * DocumentSubmitForm — public (no-login) page, route /documents/:token, where a
 * new hire uploads their joining documents from a tokenised HR link. Loads the
 * required doc-type list via GET /recruitment/documents/:token and submits the
 * files (multipart, one label per file) via POST to the same URL.
 */
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import api from '../api/client';
import BrandLockup from '../components/BrandLockup';
import FileDropField from '../components/FileDropField';
import DocSubmitPanel from '../components/DocSubmitPanel';

// Centered card layout wrapper (company logo header) shared by all page states.
function Shell({ children }) {
  return (
    <div className="min-h-full flex items-center justify-center bg-gradient-to-br from-gray-100 via-gray-50 to-blue-50 dark:from-gray-900 dark:via-gray-900 dark:to-gray-800 px-4 py-10">
      {/* Narrow (one column) on a phone; wide enough for a real tile grid up. */}
      <div className="docform-card w-full max-w-xl sm:max-w-3xl p-6 sm:p-8">
        <div className="flex flex-col items-center text-center mb-5">
          <BrandLockup variant="stacked" />
        </div>
        {children}
      </div>
    </div>
  );
}

// Document types a candidate may legitimately provide several of.
const MULTI_TYPES = new Set(['Experience Letter', 'Relieving Letter', 'Educational Certificates']);

// HR's per-document verdict, as the candidate sees it.
const REVIEW_STYLES = {
  Pending: 'bg-amber-100 text-amber-800',
  Verified: 'bg-green-100 text-green-800',
  Rejected: 'bg-red-100 text-red-800',
};

export default function DocumentSubmitForm() {
  const { token } = useParams();
  const [info, setInfo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [files, setFiles] = useState({});   // docType -> File[]
  const [others, setOthers] = useState([]); // File[]
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  // Load candidate + required doc types; if already confirmed, show done state.
  useEffect(() => {
    (async () => {
      try {
        const { data } = await api.get(`/recruitment/documents/${token}`);
        setInfo(data);
        if (data.candidate.confirmedAt) setDone(true);
      } catch (err) {
        setError(err.response?.data?.message || 'This link is unavailable.');
      } finally {
        setLoading(false);
      }
    })();
  }, [token]);

  // Bundle each picked file with a parallel 'labels' entry (its doc type) so the
  // server can map uploads back to the requested document categories.
  const submit = async (e) => {
    e.preventDefault();
    setError('');
    const picked = Object.entries(files).filter(([, list]) => (list || []).length);
    if (picked.length === 0 && others.length === 0) {
      setError('Please attach at least one document.');
      return;
    }
    setSubmitting(true);
    try {
      const fd = new FormData();
      picked.forEach(([type, list]) => list.forEach((f) => { fd.append('files', f); fd.append('labels', type); }));
      others.forEach((f) => { fd.append('files', f); fd.append('labels', 'Other'); });
      await api.post(`/recruitment/documents/${token}`, fd);
      setDone(true);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not submit your documents.');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return <Shell><p className="text-center text-gray-500">Loading…</p></Shell>;

  if (error && !info) {
    return <Shell><div className="text-center text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">{error}</div></Shell>;
  }

  if (done) {
    return (
      <Shell>
        <div className="text-center py-6">
          <div className="text-4xl mb-3">✅</div>
          <h1 className="text-xl font-bold text-gray-900">Documents submitted</h1>
          <p className="text-sm text-gray-500 mt-2">
            Thanks{info?.candidate?.name ? `, ${info.candidate.name}` : ''}. Our HR team will review your documents and get back to you.
          </p>
        </div>
      </Shell>
    );
  }

  // Progress across the requested types, so the form reads as a checklist being
  // worked through rather than an undifferentiated wall of pickers.
  const required = (info.docTypes || []).filter((t) => t !== 'Other');
  const attached = required.filter((t) => (files[t] || []).length).length;
  const pct = required.length ? Math.round((attached / required.length) * 100) : 0;

  // HR reviews each document separately, so a submission can come back
  // part-accepted. Show the verdict per type, and say plainly which ones need
  // uploading again — a rejection is useless if you can't tell what to redo.
  const reviewed = info.candidate?.files || [];
  const verdictFor = (type) => {
    const forType = reviewed.filter((f) => f.label === type);
    if (forType.some((f) => f.status === 'Verified')) return { status: 'Verified' };
    const rejected = forType.find((f) => f.status === 'Rejected');
    if (rejected) return { status: 'Rejected', note: rejected.reviewNote };
    return forType.length ? { status: 'Pending' } : null;
  };
  const needsRedo = required.filter((t) => verdictFor(t)?.status === 'Rejected');

  return (
    <Shell>
      <div className="text-center mb-5">
        <h1 className="docform-title text-2xl font-bold">Submit your documents</h1>
        <p className="docform-sub text-sm font-medium mt-1">
          {info.candidate.name}{info.candidate.jobTitle ? ` · ${info.candidate.jobTitle}` : ''}
        </p>
        <p className="text-sm text-gray-600 mt-3">
          Attach each document below. You can preview every file before sending it.
        </p>
      </div>

      {needsRedo.length > 0 && (
        <div className="mb-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3">
          <div className="text-sm font-semibold text-red-800">
            {needsRedo.length} document{needsRedo.length === 1 ? '' : 's'} need{needsRedo.length === 1 ? 's' : ''} to be uploaded again
          </div>
          <ul className="mt-1.5 space-y-1">
            {needsRedo.map((t) => (
              <li key={t} className="text-xs text-red-700">
                <span className="font-medium">{t}</span>
                {verdictFor(t)?.note ? ` — ${verdictFor(t).note}` : ''}
              </li>
            ))}
          </ul>
          <p className="text-[11px] text-red-700/90 mt-2">
            Everything else you sent has been accepted — just attach these again below.
          </p>
        </div>
      )}

      {/* Wide screens get the bar above the grid; phones get the panel inside
          the form instead (checklist + submit before the first slot). */}
      {required.length > 0 && (
        <div className="mb-5 hidden sm:block">
          <div className="flex items-center justify-between text-xs mb-1.5">
            <span className="docform-sub font-semibold">{attached} of {required.length} attached</span>
            <span className="text-gray-500">{pct}%</span>
          </div>
          <div className="docform-progress h-1.5 rounded-full overflow-hidden">
            <span style={{ width: `${pct}%` }} />
          </div>
        </div>
      )}

      <form onSubmit={submit}>
        <DocSubmitPanel
          name={info.candidate.name}
          subtitle={info.candidate.jobTitle}
          items={required.map((t) => ({ label: t, done: (files[t] || []).length > 0 }))}
          submitting={submitting}
          note="Sent straight to our HR team."
        />

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5 items-start">
          {required.map((type) => {
            const multi = MULTI_TYPES.has(type);
            const verdict = verdictFor(type);
            return (
              <FileDropField
                key={type}
                label={type}
                hint={multi ? 'add more than one' : undefined}
                multiple={multi}
                files={files[type] || []}
                onChange={(list) => setFiles((f) => ({ ...f, [type]: list }))}
                badge={verdict ? (
                  <span className={`text-[11px] px-2 py-0.5 rounded-full ${REVIEW_STYLES[verdict.status]}`}>
                    {verdict.status === 'Rejected' ? 'Upload again' : verdict.status}
                  </span>
                ) : null}
              />
            );
          })}

          {/* The catch-all spans the grid so it reads as a separate offer. */}
          <div className="sm:col-span-2 lg:col-span-3">
            <FileDropField label="Other documents" hint="optional, multiple" multiple files={others} onChange={setOthers} />
          </div>
        </div>

        {error && <div className="mt-3 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}

        <div className="hidden sm:block mt-4">
          <button type="submit" disabled={submitting} className="docform-submit w-full py-2.5 font-semibold">
            {submitting ? 'Submitting…' : 'Submit documents'}
          </button>
          <p className="text-[11px] text-center text-gray-500 mt-1.5">
            Sent straight to our HR team. You will not be able to edit them afterwards.
          </p>
        </div>
      </form>
    </Shell>
  );
}
