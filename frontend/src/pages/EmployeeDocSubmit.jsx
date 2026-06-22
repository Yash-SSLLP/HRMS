import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import api from '../api/client';
import { COMPANY_NAME, COMPANY_LOGO } from '../config/company';

function Shell({ children }) {
  return (
    <div className="min-h-full flex items-center justify-center bg-gradient-to-br from-gray-100 via-gray-50 to-blue-50 px-4 py-10">
      <div className="w-full max-w-xl bg-white shadow-lg rounded-2xl p-6 sm:p-8 border border-gray-100">
        <div className="flex flex-col items-center text-center mb-5">
          <img src={COMPANY_LOGO} alt={COMPANY_NAME} className="h-12 w-auto mb-3" />
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

// Public page (no login) where an employee submits documents from the link HR shares.
export default function EmployeeDocSubmit() {
  const { token } = useParams();
  const [info, setInfo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [files, setFiles] = useState({});   // category -> File
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

  const setFile = (type) => (e) => setFiles((f) => ({ ...f, [type]: e.target.files?.[0] || null }));

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    const picked = Object.entries(files).filter(([, f]) => f);
    if (picked.length === 0 && others.length === 0) {
      setError('Please attach at least one document.');
      return;
    }
    setSubmitting(true);
    try {
      const fd = new FormData();
      picked.forEach(([type, f]) => { fd.append('files', f); fd.append('labels', type); });
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

  const fileInput = 'block w-full text-sm text-gray-600 file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border-0 file:bg-gray-900 file:text-white hover:file:bg-gray-700';

  return (
    <Shell>
      <div className="text-center mb-5">
        <h1 className="text-2xl font-bold text-gray-900">Submit your documents</h1>
        <p className="text-sm text-gray-500 mt-1">
          {info.employee.name}{info.employee.employeeCode ? ` · ${info.employee.employeeCode}` : ''}
        </p>
        <p className="text-sm text-gray-600 mt-3">Please upload the documents below (PDF, Word, JPG or PNG, up to 10 MB each).</p>
      </div>

      {/* Already-submitted documents + status */}
      {(info.files || []).length > 0 && (
        <div className="mb-4 border border-gray-100 rounded-lg p-3">
          <div className="text-xs font-semibold text-gray-500 mb-2">Already submitted</div>
          <ul className="space-y-1.5">
            {info.files.map((f, i) => (
              <li key={i} className="flex items-center justify-between gap-2 text-sm">
                <span className="truncate"><span className="text-gray-500">{f.category}:</span> {f.fileName}</span>
                <span className={`text-xs px-2 py-0.5 rounded-lg shrink-0 ${STATUS_STYLES[f.status] || 'bg-gray-100 text-gray-700'}`}>{f.status}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <form onSubmit={submit} className="space-y-3">
        {(info.docTypes || []).filter((t) => t !== 'Other').map((type) => (
          <div key={type}>
            <label className="block text-sm font-medium text-gray-700 mb-1">{type}</label>
            <input type="file" accept=".pdf,.doc,.docx,.jpg,.jpeg,.png" onChange={setFile(type)} className={fileInput} />
          </div>
        ))}

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Other documents <span className="text-gray-400 font-normal">(optional, multiple)</span></label>
          <input
            type="file" multiple accept=".pdf,.doc,.docx,.jpg,.jpeg,.png"
            onChange={(e) => setOthers(Array.from(e.target.files || []))}
            className={fileInput}
          />
        </div>

        {error && <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}

        <button type="submit" disabled={submitting} className="w-full bg-gray-900 text-white py-2.5 rounded-lg font-medium hover:bg-gray-700 disabled:opacity-60">
          {submitting ? 'Submitting…' : 'Submit documents'}
        </button>
      </form>
    </Shell>
  );
}
