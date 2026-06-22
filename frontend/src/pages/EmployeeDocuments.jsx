import { useEffect, useRef, useState } from 'react';
import api from '../api/client';
import { downloadFile } from '../api/download';
import PageHeader from '../components/PageHeader';

const fmtSize = (n) => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
};

const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN') : '');

const STATUS_STYLES = {
  Submitted: 'bg-amber-100 text-amber-800',
  Verified: 'bg-green-100 text-green-800',
  Rejected: 'bg-red-100 text-red-800',
};

export default function EmployeeDocuments() {
  const [docs, setDocs] = useState([]);
  const [categories, setCategories] = useState([]);
  const [hrOnly, setHrOnly] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [category, setCategory] = useState('');
  const [note, setNote] = useState('');
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef(null);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const [docsRes, catRes] = await Promise.all([
        api.get('/documents/me'),
        api.get('/documents/categories'),
      ]);
      setDocs(docsRes.data.documents);
      setCategories(catRes.data.selfUpload || []);
      setHrOnly(catRes.data.hrOnly || []);
      if (!category && catRes.data.selfUpload?.length) {
        setCategory(catRes.data.selfUpload[0]);
      }
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load documents');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  const onUpload = async (e) => {
    e.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setError('Please choose a file first');
      return;
    }
    setUploading(true);
    setError('');
    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('category', category);
      if (note) formData.append('note', note);
      await api.post('/documents/me', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      fileRef.current.value = '';
      setNote('');
      await load();
    } catch (err) {
      setError(err.response?.data?.message || 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  const onDownload = (d) => downloadFile(`/documents/${d._id}/download`, d.fileName);

  const onDelete = async (d) => {
    if (!window.confirm(`Delete "${d.fileName}"? This cannot be undone.`)) return;
    try {
      await api.delete(`/documents/${d._id}`);
      await load();
    } catch (err) {
      alert(err.response?.data?.message || 'Delete failed');
    }
  };

  return (
    <div>
      <PageHeader title="My Documents" />

      {error && (
        <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>
      )}

      <div className="bg-white shadow rounded-lg p-5 mb-6">
        <h2 className="card-title mb-3">Upload a document</h2>
        <form onSubmit={onUpload} className="space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div>
              <label className="block text-sm text-gray-700">Category</label>
              <select value={category} onChange={(e) => setCategory(e.target.value)}
                className="mt-1 block w-full border rounded-lg px-3 py-2">
                {categories.map((c) => <option key={c}>{c}</option>)}
              </select>
            </div>
            <div className="md:col-span-2">
              <label className="block text-sm text-gray-700">File (PDF / JPG / PNG / DOCX, max 5 MB)</label>
              <input ref={fileRef} type="file" required
                accept=".pdf,.jpg,.jpeg,.png,.webp,.heic,.doc,.docx"
                className="mt-1 block w-full text-sm" />
            </div>
          </div>
          <div>
            <label className="block text-sm text-gray-700">Note (optional)</label>
            <input value={note} onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. PAN card front side"
              className="mt-1 block w-full border rounded-lg px-3 py-2" />
          </div>
          <div className="flex items-center justify-between">
            <p className="text-xs text-gray-500">
              Documents like Offer Letter, Appraisal etc. ({hrOnly.join(', ')}) are uploaded by HR.
            </p>
            <button type="submit" disabled={uploading}
              className="px-4 py-2 bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60 text-sm">
              {uploading ? 'Uploading…' : 'Upload'}
            </button>
          </div>
        </form>
      </div>

      <div className="bg-white shadow rounded-lg overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Category</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">File</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Size</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Uploaded</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Status</th>
              <th className="px-4 py-3 text-right"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr><td colSpan={6} className="px-4 py-6 text-center text-gray-500">Loading…</td></tr>
            ) : docs.length === 0 ? (
              <tr><td colSpan={6} className="px-4 py-6 text-center text-gray-500">No documents yet</td></tr>
            ) : docs.map((d) => {
              const canDelete = !hrOnly.includes(d.category);
              return (
                <tr key={d._id}>
                  <td className="px-4 py-3">
                    <span className="inline-block px-2 py-0.5 text-xs bg-gray-100 rounded-lg">{d.category}</span>
                    {d.isPii && (
                      <span className="ml-1 inline-block px-2 py-0.5 text-xs bg-amber-100 text-amber-800 rounded-lg">PII</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {d.fileName}
                    {d.note && <div className="text-xs text-gray-500">{d.note}</div>}
                  </td>
                  <td className="px-4 py-3 text-gray-600">{fmtSize(d.sizeBytes)}</td>
                  <td className="px-4 py-3 text-gray-600">{fmtDate(d.createdAt)}</td>
                  <td className="px-4 py-3">
                    <span className={`text-xs px-2 py-0.5 rounded-lg ${STATUS_STYLES[d.status || 'Submitted']}`}>{d.status || 'Submitted'}</span>
                    {d.reviewNote && <div className="text-xs text-gray-500 mt-0.5">{d.reviewNote}</div>}
                  </td>
                  <td className="px-4 py-3 text-right space-x-2 whitespace-nowrap">
                    <button onClick={() => onDownload(d)} className="text-blue-600 hover:underline">Download</button>
                    {canDelete && (
                      <button onClick={() => onDelete(d)} className="text-red-600 hover:underline">Delete</button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
