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

export default function DocumentSubmitForm() {
  const { token } = useParams();
  const [info, setInfo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [files, setFiles] = useState({});   // docType -> File
  const [others, setOthers] = useState([]); // File[]
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

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

  const fileInput = 'block w-full text-sm text-gray-600 file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border-0 file:bg-gray-900 file:text-white hover:file:bg-gray-700';

  return (
    <Shell>
      <div className="text-center mb-5">
        <h1 className="text-2xl font-bold text-gray-900">Submit your documents</h1>
        <p className="text-sm text-gray-500 mt-1">
          {info.candidate.name}{info.candidate.jobTitle ? ` · ${info.candidate.jobTitle}` : ''}
        </p>
        <p className="text-sm text-gray-600 mt-3">Please upload the documents below (PDF, Word, JPG or PNG, up to 10 MB each).</p>
      </div>

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
