/**
 * EmployeeDocSubmit — public (no-login) page, route /submit-docs/:token, where an
 * existing employee uploads documents from the tokenised link HR shares. Loads
 * the required doc-type list + already-submitted files (with HR verify status)
 * from GET /employees/public-docs/:token and submits via POST to the same URL.
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

const STATUS_STYLES = {
  Submitted: 'bg-amber-100 text-amber-800',
  Verified: 'bg-green-100 text-green-800',
  Rejected: 'bg-red-100 text-red-800',
};

// Category keys come from the backend enum (e.g. "ExperienceLetter"); show them
// with spaces ("Experience Letter"). The raw key is still what we submit.
const humanize = (c) => String(c).replace(/([a-z])([A-Z])/g, '$1 $2');
// Categories a person may legitimately have several of (past employers, degrees).
const MULTI_CATEGORIES = new Set(['ExperienceLetter', 'RelievingLetter', 'EducationCertificate']);

export default function EmployeeDocSubmit() {
  const { token } = useParams();
  const [info, setInfo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [files, setFiles] = useState({});   // category -> File[]
  const [others, setOthers] = useState([]); // File[]
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  const load = async () => {
    try {
      const { data } = await api.get(`/employees/public-docs/${token}`);
      setInfo(data);
    } catch (err) {
      setError(err.response?.data?.message || 'This link is unavailable.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [token]);

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
      // Pair each file with a parallel 'labels' entry so the server can map
      // uploads to the requested categories ('Other' for the free-form bucket).
      const fd = new FormData();
      picked.forEach(([type, list]) => list.forEach((f) => { fd.append('files', f); fd.append('labels', type); }));
      others.forEach((f) => { fd.append('files', f); fd.append('labels', 'Other'); });
      await api.post(`/employees/public-docs/${token}`, fd);
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
            Thanks{info?.employee?.name ? `, ${info.employee.name}` : ''}. Our HR team will review your documents.
          </p>
        </div>
      </Shell>
    );
  }

  // Anything HR already holds for a category is shown on its row, so the person
  // can see they have nothing left to do there (or that HR rejected a file and
  // wants it again) instead of re-uploading blind.
  const statusFor = (category) => (info.files || []).find((f) => f.category === category)?.status;
  const required = (info.docTypes || []).filter((t) => t !== 'Other');
  const settled = required.filter((t) => (files[t] || []).length || statusFor(t)).length;
  const pct = required.length ? Math.round((settled / required.length) * 100) : 0;

  return (
    <Shell>
      <div className="text-center mb-5">
        <h1 className="docform-title text-2xl font-bold">Submit your documents</h1>
        <p className="docform-sub text-sm font-medium mt-1">
          {info.employee.name}{info.employee.employeeCode ? ` · ${info.employee.employeeCode}` : ''}
        </p>
        <p className="text-sm text-gray-600 mt-3">
          Attach each document below. You can preview every file before sending it.
        </p>
      </div>

      {/* Wide screens get the bar above the grid; phones get the panel inside
          the form instead (checklist + submit before the first slot). */}
      {required.length > 0 && (
        <div className="mb-5 hidden sm:block">
          <div className="flex items-center justify-between text-xs mb-1.5">
            <span className="docform-sub font-semibold">{settled} of {required.length} covered</span>
            <span className="text-gray-500">{pct}%</span>
          </div>
          <div className="docform-progress h-1.5 rounded-full overflow-hidden">
            <span style={{ width: `${pct}%` }} />
          </div>
        </div>
      )}

      <form onSubmit={submit}>
        <DocSubmitPanel
          name={info.employee.name}
          subtitle={info.employee.employeeCode}
          items={required.map((t) => ({ label: humanize(t), done: (files[t] || []).length > 0 || !!statusFor(t) }))}
          submitting={submitting}
          note="Sent to HR for verification."
        />

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5 items-start">
          {required.map((type) => {
            const multi = MULTI_CATEGORIES.has(type);
            const status = statusFor(type);
            return (
              <FileDropField
                key={type}
                label={humanize(type)}
                hint={multi ? 'add more than one' : undefined}
                multiple={multi}
                files={files[type] || []}
                onChange={(list) => setFiles((f) => ({ ...f, [type]: list }))}
                badge={status ? (
                  <span className={`text-[11px] px-2 py-0.5 rounded-full ${STATUS_STYLES[status] || 'bg-gray-100 text-gray-700'}`}>{status}</span>
                ) : null}
              />
            );
          })}

          <div className="sm:col-span-2 lg:col-span-3">
            <FileDropField label="Other documents" hint="optional, multiple" multiple files={others} onChange={setOthers} />
          </div>
        </div>

        <div className="mt-2.5 space-y-2.5">
        {(info.files || []).length > 0 && (
          <details className="docfield rounded-xl">
            <summary className="text-sm font-semibold docfield-label cursor-pointer">
              Already submitted ({info.files.length})
            </summary>
            <ul className="mt-2 space-y-1.5">
              {info.files.map((f, i) => (
                <li key={i} className="flex items-center justify-between gap-2 text-sm">
                  <span className="truncate docfield-filename">
                    <span className="docfield-meta">{humanize(f.category)}:</span> {f.fileName}
                  </span>
                  <span className={`text-xs px-2 py-0.5 rounded-lg shrink-0 ${STATUS_STYLES[f.status] || 'bg-gray-100 text-gray-700'}`}>{f.status}</span>
                </li>
              ))}
            </ul>
          </details>
        )}

        {error && <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}

        <div className="hidden sm:block">
          <button type="submit" disabled={submitting} className="docform-submit w-full py-2.5 font-semibold">
            {submitting ? 'Submitting…' : 'Submit documents'}
          </button>
          <p className="text-[11px] text-center text-gray-500 mt-1.5">
            Sent straight to our HR team for verification.
          </p>
        </div>
        </div>
      </form>
    </Shell>
  );
}
