/**
 * AdminDocuments — employee document management (admin portal). Lists documents
 * (optionally filtered by employee) from GET /documents, uploads on an employee's
 * behalf via POST /documents (one file per request), verifies/rejects via
 * PATCH /documents/:id/status, and downloads/deletes via /documents/:id.
 * Employee + category lists from GET /employees and GET /documents/categories.
 */
import { useEffect, useRef, useState } from 'react';
import { toast } from 'react-toastify';
import api from '../api/client';
import { downloadFile } from '../api/download';
import PageHeader from '../components/PageHeader';
import { confirmDialog, promptDialog } from '../components/dialogs';
import DocPreviewModal from '../components/DocPreviewModal';
import SearchableSelect from '../components/SearchableSelect';

const fmtSize = (n) => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
};
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '');

const STATUS_STYLES = {
  Submitted: 'bg-amber-100 text-amber-800',
  Verified: 'bg-green-100 text-green-800',
  Rejected: 'bg-red-100 text-red-800',
};

// Show enum keys ("RelievingLetter") with spaces ("Relieving Letter").
const humanize = (c) => String(c).replace(/([a-z])([A-Z])/g, '$1 $2');

export default function AdminDocuments() {
  const [employees, setEmployees] = useState([]);
  // The document open in the preview modal (see the View action).
  const [previewDoc, setPreviewDoc] = useState(null);
  const [selectedEmployee, setSelectedEmployee] = useState('');
  const [docs, setDocs] = useState([]);
  // The page's whole job is verifying what employees submit, and there was no
  // way to see only what is waiting. Defaults to Submitted for that reason.
  const [statusFilter, setStatusFilter] = useState('Submitted');
  // Filtered client-side: the list is one employee's documents, or one
  // page's worth, so there is nothing here worth another round trip.
  const shownDocs = statusFilter ? docs.filter((d) => d.status === statusFilter) : docs;
  const [allCategories, setAllCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [category, setCategory] = useState('OfferLetter');
  const [note, setNote] = useState('');
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef(null);

  const loadEmployees = async () => {
    try {
      const [empRes, catRes] = await Promise.all([
        api.get('/employees?excludeExecutives=true'),
        api.get('/documents/categories'),
      ]);
      setEmployees(empRes.data.profiles);
      setAllCategories(catRes.data.all || []);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load employees');
    }
  };

  const loadDocs = async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (selectedEmployee) params.set('employee', selectedEmployee);
      const { data } = await api.get(`/documents?${params}`);
      setDocs(data.documents);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load documents');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadEmployees(); }, []);
  useEffect(() => { loadDocs(); /* eslint-disable-next-line */ }, [selectedEmployee]);

  const onUpload = async (e) => {
    e.preventDefault();
    if (!selectedEmployee) {
      setError('Pick an employee first');
      return;
    }
    const list = Array.from(fileRef.current?.files || []);
    if (!list.length) {
      setError('Please choose a file first');
      return;
    }
    setUploading(true);
    setError('');
    try {
      // One file per request; upload each so a category like Experience Letter
      // can hold several at once.
      for (const file of list) {
        const formData = new FormData();
        formData.append('file', file);
        formData.append('employee', selectedEmployee);
        formData.append('category', category);
        if (note) formData.append('note', note);
        await api.post('/documents', formData, {
          headers: { 'Content-Type': 'multipart/form-data' },
        });
      }
      fileRef.current.value = '';
      setNote('');
      await loadDocs();
    } catch (err) {
      setError(err.response?.data?.message || 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  const onDownload = (d) => downloadFile(`/documents/${d._id}/download`, d.fileName);

  const setDocStatus = async (d, status) => {
    let note;
    if (status === 'Rejected') note = (await promptDialog({ message: 'Reason for rejecting (optional):' })) || '';
    try {
      await api.patch(`/documents/${d._id}/status`, { status, note });
      await loadDocs();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not update status');
    }
  };

  const onDelete = async (d) => {
    if (!(await confirmDialog({ message: `Delete "${d.fileName}"? This cannot be undone.`, tone: 'danger', confirmText: 'Delete' }))) return;
    try {
      await api.delete(`/documents/${d._id}`);
      await loadDocs();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Delete failed');
    }
  };

  return (
    <div>
      <PageHeader title="Employee Documents" />

      <ReplacementRequests onChanged={loadDocs} />

      <div className="bg-white shadow rounded-lg p-4 mb-4 flex gap-3 items-end flex-wrap">
        <div className="flex-1 min-w-[240px]">
          <label className="block text-xs text-gray-600">Employee</label>
          <SearchableSelect value={selectedEmployee}
            onChange={(e) => setSelectedEmployee(e.target.value)}
            className="mt-1 block w-full border rounded-lg px-3 py-2 text-sm">
            <option value="">All employees</option>
            {employees.map((e) => (
              <option key={e._id} value={e._id}>
                {e.employeeCode} · {e.user?.firstName} {e.user?.lastName}
              </option>
            ))}
          </SearchableSelect>
        </div>
        <div className="min-w-[160px]">
          <label className="block text-xs text-gray-600">Status</label>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}
            className="mt-1 block w-full border rounded-lg px-3 py-2 text-sm">
            <option value="">All statuses</option>
            <option value="Submitted">Waiting for review</option>
            <option value="Verified">Verified</option>
            <option value="Rejected">Rejected</option>
          </select>
        </div>
      </div>

      {error && (
        <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>
      )}

      {selectedEmployee && (
        <div className="bg-white shadow rounded-lg p-5 mb-6">
          <h2 className="card-title mb-3">Upload on behalf of employee</h2>
          <form onSubmit={onUpload} className="space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div>
                <label className="block text-sm text-gray-700">Category</label>
                <SearchableSelect value={category} onChange={(e) => setCategory(e.target.value)}
                  className="mt-1 block w-full border rounded-lg px-3 py-2">
                  {allCategories.map((c) => <option key={c} value={c}>{humanize(c)}</option>)}
                </SearchableSelect>
              </div>
              <div className="md:col-span-2">
                <label className="block text-sm text-gray-700">File - you can select several</label>
                <input ref={fileRef} type="file" required multiple
                  accept=".pdf,.jpg,.jpeg,.png,.webp,.heic,.doc,.docx"
                  className="mt-1 block w-full text-sm" />
              </div>
            </div>
            <div>
              <label className="block text-sm text-gray-700">Note (optional)</label>
              <input value={note} onChange={(e) => setNote(e.target.value)}
                className="mt-1 block w-full border rounded-lg px-3 py-2" />
            </div>
            <div className="flex justify-end">
              <button type="submit" disabled={uploading}
                className="px-4 py-2 bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60 text-sm">
                {uploading ? 'Uploading…' : 'Upload'}
              </button>
            </div>
          </form>
        </div>
      )}

      <div className="bg-white shadow rounded-lg overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              {!selectedEmployee && (
                <th className="px-4 py-3 text-left font-medium text-gray-700">Employee</th>
              )}
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
              <tr><td colSpan={selectedEmployee ? 6 : 7} className="px-4 py-4"><div className="space-y-2.5"><div className="skeleton h-4 rounded" /><div className="skeleton h-4 rounded w-5/6" /><div className="skeleton h-4 rounded w-2/3" /></div></td></tr>
            ) : shownDocs.length === 0 ? (
              <tr><td colSpan={selectedEmployee ? 6 : 7} className="px-4 py-6 text-center text-gray-500">No documents</td></tr>
            ) : shownDocs.map((d) => (
              <tr key={d._id}>
                {!selectedEmployee && (
                  <td className="px-4 py-3">
                    {d.employee?.user?.firstName} {d.employee?.user?.lastName}
                    <div className="text-xs text-gray-500 font-mono">{d.employee?.employeeCode}</div>
                  </td>
                )}
                <td className="px-4 py-3">
                  <span className="inline-block px-2 py-0.5 text-xs bg-gray-100 rounded-lg">{humanize(d.category)}</span>
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
                  {d.status !== 'Verified' && (
                    <button onClick={() => setDocStatus(d, 'Verified')} className="text-green-700 hover:underline">Verify</button>
                  )}
                  {d.status !== 'Rejected' && (
                    <button onClick={() => setDocStatus(d, 'Rejected')} className="text-amber-700 hover:underline">Reject</button>
                  )}
                  <button onClick={() => setPreviewDoc(d)} className="text-blue-600 hover:underline">View</button>
                  <button onClick={() => onDownload(d)} className="text-blue-600 hover:underline">Download</button>
                  <button onClick={() => onDelete(d)} className="text-red-600 hover:underline">Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {previewDoc && <DocPreviewModal doc={previewDoc} onClose={() => setPreviewDoc(null)} />}
    </div>
  );
}

// HR inbox of employee document-replacement requests. Approving swaps the new
// file in for the locked one; declining discards it. Reloads the doc list so a
// swap shows immediately.
function ReplacementRequests({ onChanged }) {
  const [requests, setRequests] = useState([]);
  const [busyId, setBusyId] = useState(null);
  const [err, setErr] = useState('');

  const load = async () => {
    try {
      const { data } = await api.get('/documents/replace-requests/assigned');
      setRequests((data.requests || []).filter((r) => r.status === 'pending'));
    } catch (e) {
      setErr(e.response?.data?.message || 'Could not load replacement requests');
    }
  };
  useEffect(() => { load(); }, []);

  const decide = async (r, action) => {
    let note = '';
    if (action === 'decline') note = (await promptDialog({ message: 'Reason for declining (optional):' })) || '';
    setBusyId(r._id); setErr('');
    try {
      await api.patch(`/documents/replace-requests/${r._id}`, { action, decisionNote: note });
      await load();
      if (onChanged) await onChanged();
    } catch (e) {
      setErr(e.response?.data?.message || 'Action failed');
    } finally {
      setBusyId(null);
    }
  };

  if (requests.length === 0) return null;
  return (
    <div className="bg-amber-50 border border-amber-200 shadow-sm rounded-lg p-4 mb-4">
      <div className="text-sm font-semibold text-amber-900 mb-2">Document replacement requests ({requests.length})</div>
      {err && <div className="text-xs text-red-700 mb-2">{err}</div>}
      <ul className="divide-y divide-amber-200">
        {requests.map((r) => {
          const who = r.employee?.user ? `${r.employee.user.firstName || ''} ${r.employee.user.lastName || ''}`.trim() : (r.requestedBy ? `${r.requestedBy.firstName || ''} ${r.requestedBy.lastName || ''}`.trim() : 'Employee');
          return (
            <li key={r._id} className="py-2 flex items-center justify-between gap-3 flex-wrap">
              <div className="min-w-0 text-sm">
                <span className="font-medium text-gray-900">{who}</span>
                <span className="text-gray-500"> wants to replace </span>
                <span className="font-medium text-gray-800">{r.category}</span>
                <span className="text-gray-500"> · new file: {r.fileName || 'attached'}</span>
                {r.reason && <div className="text-xs text-gray-500 italic">“{r.reason}”</div>}
              </div>
              <div className="flex gap-2 shrink-0">
                <button disabled={busyId === r._id} onClick={() => decide(r, 'approve')}
                  className="bg-green-600 text-white text-xs px-3 py-1.5 rounded-lg font-medium hover:bg-green-700 disabled:opacity-60">
                  {busyId === r._id ? '…' : 'Approve & swap'}
                </button>
                <button disabled={busyId === r._id} onClick={() => decide(r, 'decline')}
                  className="bg-white border border-gray-300 text-gray-700 text-xs px-3 py-1.5 rounded-lg font-medium hover:bg-gray-50 disabled:opacity-60">
                  Decline
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
