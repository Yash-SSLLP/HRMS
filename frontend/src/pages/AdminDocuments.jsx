/**
 * AdminDocuments — employee document management (admin portal). Lists documents
 * (optionally filtered by employee) from GET /documents, uploads on an employee's
 * behalf via POST /documents (one file per request), verifies/rejects via
 * PATCH /documents/:id/status, and downloads/deletes via /documents/:id.
 * Employee + category lists from GET /employees and GET /documents/categories.
 *
 * 2026-10-03 redesign ("make it more premium"): KPI cards per status that double
 * as the filter, one toolbar (status views + employee picker), and one review
 * card per document grouped by the day it was uploaded. Behaviour unchanged.
 * Styling: styles/pages/docs-assets.css (`.doc-*`).
 */
import { useEffect, useRef, useState } from 'react';
import { toast } from 'react-toastify';
import {
  FiAlertCircle, FiCheck, FiCheckCircle, FiClock, FiDownload, FiEye, FiFile, FiFileText, FiImage,
  FiLock, FiPaperclip, FiRefreshCw, FiTrash2, FiUpload, FiX, FiXCircle,
} from 'react-icons/fi';
import '../styles/pages/docs-assets.css';
import api from '../api/client';
import { downloadFile } from '../api/download';
import PageHeader from '../components/PageHeader';
import { confirmDialog, promptDialog } from '../components/dialogs';
import DocPreviewModal from '../components/DocPreviewModal';
import SearchableSelect from '../components/SearchableSelect';
import { PersonAvatar } from '../components/permissions/permUi';
import { peopleOptions } from '../utils/peopleOptions';
import { docLabel } from '../utils/docCategories';
import { toYMD } from '../utils/time';

const fmtSize = (n) => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
};

// Status → the review card's tone and the pill's colour.
const STATUS_TONE = { Submitted: 'is-submitted', Verified: 'is-verified', Rejected: 'is-rejected' };

// What kind of file a row holds — picks the tile's icon and hue. Same tests the
// preview modal uses to decide image vs PDF.
const fileKind = (d) => {
  const mime = d?.mime || '';
  const name = d?.fileName || '';
  if (mime.startsWith('image/') || /\.(png|jpe?g|webp|gif|heic)$/i.test(name)) return 'img';
  if (mime === 'application/pdf' || /\.pdf$/i.test(name)) return 'pdf';
  if (/word|officedocument/.test(mime) || /\.docx?$/i.test(name)) return 'doc';
  return 'file';
};
const KIND_ICON = { img: FiImage, pdf: FiFileText, doc: FiFileText, file: FiFile };
const extOf = (name) => {
  const m = /\.([a-z0-9]{1,5})$/i.exec(name || '');
  return m ? m[1].toUpperCase() : '';
};

/** "Today" / "Yesterday" / "Thursday, 2 Oct 2026" — the upload-day heading. */
const dayHeading = (ymd) => {
  if (!ymd) return 'Undated';
  if (ymd === toYMD(new Date())) return 'Today';
  if (ymd === toYMD(new Date(Date.now() - 86400000))) return 'Yesterday';
  return new Date(`${ymd}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'short', year: 'numeric' });
};

// Category names come from utils/docCategories — "PassportPhoto" is asked for
// as a Passport Size Photo, which no camelCase split can know.
const humanize = (c) => docLabel(c);

// Mirrors backend/routes/documentRoutes.js's ceiling — keep the two in step.
const MAX_UPLOAD_MB = 10;

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
      // `all` is every value a document may CARRY, retired ones included, so a
      // row already filed under one still renders. What may be uploaded now is
      // that minus the retired set — see documentController.categories.
      const retired = new Set(catRes.data.retired || []);
      setAllCategories((catRes.data.all || []).filter((c) => !retired.has(c)));
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
    // Same reasoning as the employee page: multer aborts a too-large upload
    // without draining the request, so the browser sees the socket close and
    // reports "Network Error" instead of the server's explanation. Refuse here.
    const tooBig = list.filter((f) => f.size > MAX_UPLOAD_MB * 1024 * 1024);
    if (tooBig.length) {
      setError(`${tooBig.map((f) => f.name).join(', ')} — over ${MAX_UPLOAD_MB} MB. Please attach a smaller copy.`);
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

  // ---- Presentation only: counts, grouping, the reload veil ----
  // Counted with the same test the filter uses, so a card's number is exactly
  // what clicking it shows.
  const counts = { all: docs.length, Submitted: 0, Verified: 0, Rejected: 0, pii: 0 };
  docs.forEach((d) => {
    if (d.status === 'Submitted' || d.status === 'Verified' || d.status === 'Rejected') counts[d.status] += 1;
    if (d.isPii) counts.pii += 1;
  });
  // The first load paints skeletons; a reload after a verify / delete / upload
  // keeps the cards where they are and only dims them.
  const firstLoad = loading && docs.length === 0;
  const reloading = loading && docs.length > 0;

  // Grouped by the day each document was uploaded (the list is newest first).
  const groups = [];
  const byDay = new Map();
  shownDocs.forEach((d) => {
    const k = toYMD(d.createdAt);
    if (!byDay.has(k)) { byDay.set(k, []); groups.push([k, byDay.get(k)]); }
    byDay.get(k).push(d);
  });

  const picked = selectedEmployee ? employees.find((e) => e._id === selectedEmployee) : null;
  const pickedName = picked ? `${picked.user?.firstName || ''} ${picked.user?.lastName || ''}`.trim() : '';

  const KPIS = [
    { key: 'Submitted', label: 'Waiting for review', value: counts.Submitted, icon: FiClock, hue: '#d97706' },
    { key: 'Verified', label: 'Verified', value: counts.Verified, icon: FiCheckCircle, hue: '#16a34a' },
    { key: 'Rejected', label: 'Rejected', value: counts.Rejected, icon: FiXCircle, hue: '#dc2626' },
    { key: '', label: 'All documents', value: counts.all, icon: FiFileText, hue: '#6366f1', sub: counts.pii ? `${counts.pii} PII` : '' },
  ];
  const VIEWS = [
    { key: 'Submitted', label: 'Waiting for review', n: counts.Submitted },
    { key: 'Verified', label: 'Verified', n: counts.Verified },
    { key: 'Rejected', label: 'Rejected', n: counts.Rejected },
    { key: '', label: 'All', n: counts.all },
  ];

  return (
    <div className="doc-page">
      <PageHeader title="Employee Documents" />

      <ReplacementRequests onChanged={loadDocs} />

      <div className="trn-kpis">
        {KPIS.map((k) => {
          const Icon = k.icon;
          const on = statusFilter === k.key;
          return (
            <button key={k.key || 'all'} type="button" onClick={() => setStatusFilter(k.key)} aria-pressed={on}
              className={`trn-kpi pb-kpi${on ? ' is-on' : ''}`} style={{ '--kpi-hue': k.hue }}>
              <span className="trn-kpi-icon" aria-hidden="true"><Icon size={19} /></span>
              <span className="min-w-0">
                <span className="trn-kpi-value block">{firstLoad ? '—' : k.value}</span>
                <span className="trn-kpi-label block">{k.label}</span>
                {k.sub && <span className="trn-kpi-sub block">{k.sub}</span>}
              </span>
            </button>
          );
        })}
      </div>

      <div className="pb-toolbar mt-4">
        <div className="trn-seg" role="tablist" aria-label="Status">
          {VIEWS.map((v) => (
            <button key={v.key || 'all'} type="button" role="tab" aria-selected={statusFilter === v.key}
              onClick={() => setStatusFilter(v.key)}
              className={`trn-seg-btn${statusFilter === v.key ? ' is-on' : ''}`}>
              {v.label} <span className="trn-seg-count">{v.n}</span>
            </button>
          ))}
        </div>
        <div className="pb-toolbar-end">
          <div className="doc-emp">
            <SearchableSelect value={selectedEmployee}
              onChange={(e) => setSelectedEmployee(e.target.value)}
              aria-label="Employee"
              className="trn-select w-full">
              <option value="">All employees</option>
              {peopleOptions(employees, (e) => `${e.employeeCode} · ${e.user?.firstName || ''} ${e.user?.lastName || ''}`, { keep: [selectedEmployee] })}
            </SearchableSelect>
          </div>
        </div>
      </div>

      {error && (
        <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2.5 rounded-xl">{error}</div>
      )}

      {selectedEmployee && (
        <section className="doc-upload">
          <div className="doc-upload-head">
            <span className="doc-upload-icon" aria-hidden="true"><FiUpload size={17} /></span>
            <div className="min-w-0">
              <div className="prm-card-title">Upload on behalf of employee</div>
              {pickedName && <div className="doc-upload-sub">{pickedName}{picked?.employeeCode ? ` · ${picked.employeeCode}` : ''}</div>}
            </div>
          </div>
          <form onSubmit={onUpload} className="doc-upload-form">
            <div className="doc-upload-cat">
              <label className="prm-label">Category</label>
              <SearchableSelect value={category} onChange={(e) => setCategory(e.target.value)}
                className="prm-input block w-full">
                {allCategories.map((c) => <option key={c} value={c}>{humanize(c)}</option>)}
              </SearchableSelect>
            </div>
            <div className="doc-upload-file">
              <label className="prm-label">File - you can select several</label>
              <input ref={fileRef} type="file" required multiple
                accept=".pdf,image/*,.doc,.docx"
                className="doc-file-input" />
            </div>
            <div className="doc-upload-note">
              <label className="prm-label">Note (optional)</label>
              <input value={note} onChange={(e) => setNote(e.target.value)} className="prm-input" />
            </div>
            <div className="doc-upload-go">
              <button type="submit" disabled={uploading} className="trn-btn is-primary accent-bg text-white">
                <FiUpload size={14} /> {uploading ? 'Uploading…' : 'Upload'}
              </button>
            </div>
          </form>
        </section>
      )}

      {firstLoad ? (
        <div className="space-y-2.5">{[0, 1, 2, 3].map((i) => <div key={i} className="skeleton h-20 rounded-2xl" />)}</div>
      ) : shownDocs.length === 0 ? (
        <div className={`prm-list${reloading ? ' doc-dim' : ''}`}>
          <div className="trn-empty">
            <span className="trn-empty-icon"><FiFileText size={24} /></span>
            <p className="text-sm font-semibold">No documents</p>
          </div>
        </div>
      ) : (
        <div className={reloading ? 'doc-dim' : ''} aria-busy={reloading || undefined}>
          {groups.map(([ymd, list]) => {
            return (
              <section key={ymd || 'undated'} className="rst-day">
                <div className="rst-day-head">
                  <span className="rst-day-title">{dayHeading(ymd)}</span>
                  <span className="rst-day-count">{list.length}</span>
                </div>
                <div className="doc-list">
                  {list.map((d) => {
                    const status = d.status || 'Submitted';
                    const kind = fileKind(d);
                    const KindIcon = KIND_ICON[kind];
                    const ext = extOf(d.fileName);
                    const who = d.employee?.user;
                    return (
                      <article key={d._id} className={`doc-card ${STATUS_TONE[status] || 'is-submitted'}${selectedEmployee ? ' is-one' : ''}`}>
                        <span className={`doc-tile is-${kind}`} aria-hidden="true">
                          <KindIcon size={18} />
                          {ext && <span className="doc-tile-ext">{ext}</span>}
                        </span>

                        <div className="doc-file">
                          <div className="doc-file-name" title={d.fileName}>{d.fileName}</div>
                          <div className="doc-file-tags">
                            <span className="doc-cat">{humanize(d.category)}</span>
                            {d.isPii && <span className="trn-tag is-amber"><FiLock size={10} /> PII</span>}
                            <span className="doc-size">{fmtSize(d.sizeBytes)}</span>
                          </div>
                          {d.note && <div className="doc-note">{d.note}</div>}
                          {d.reviewNote && <div className="doc-review-note">{d.reviewNote}</div>}
                        </div>

                        {!selectedEmployee && (
                          <div className="doc-who">
                            <PersonAvatar user={who} size="sm" />
                            <div className="min-w-0">
                              <div className="doc-who-name">{who?.firstName} {who?.lastName}</div>
                              <div className="doc-who-code">{d.employee?.employeeCode}</div>
                            </div>
                          </div>
                        )}

                        <div className="doc-side">
                          <span className={`doc-status ${STATUS_TONE[status] || 'is-submitted'}`}>{status}</span>
                          <div className="doc-actions">
                            {d.status !== 'Verified' && (
                              <button type="button" onClick={() => setDocStatus(d, 'Verified')} className="trn-btn rg-approve doc-act">
                                <FiCheck size={14} /> Verify
                              </button>
                            )}
                            {d.status !== 'Rejected' && (
                              <button type="button" onClick={() => setDocStatus(d, 'Rejected')} className="trn-btn is-danger doc-act">
                                <FiX size={14} /> Reject
                              </button>
                            )}
                            <span className="doc-tools">
                              <button type="button" onClick={() => setPreviewDoc(d)} className="trn-icon-btn doc-ibtn"
                                aria-label={`View ${d.fileName}`} title="View"><FiEye size={16} /></button>
                              <button type="button" onClick={() => onDownload(d)} className="trn-icon-btn doc-ibtn"
                                aria-label={`Download ${d.fileName}`} title="Download"><FiDownload size={16} /></button>
                              <button type="button" onClick={() => onDelete(d)} className="trn-icon-btn doc-ibtn doc-del"
                                aria-label={`Delete ${d.fileName}`} title="Delete"><FiTrash2 size={16} /></button>
                            </span>
                          </div>
                        </div>
                      </article>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
      )}

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
    <section className="doc-req">
      <div className="doc-req-head">
        <span className="doc-req-icon" aria-hidden="true"><FiRefreshCw size={17} /></span>
        <span className="doc-req-title">Document replacement requests</span>
        <span className="doc-req-count">{requests.length}</span>
      </div>
      {err && <div className="doc-req-err"><FiAlertCircle size={13} /> {err}</div>}
      <ul className="doc-req-list">
        {requests.map((r) => {
          const person = r.employee?.user || r.requestedBy;
          const who = r.employee?.user ? `${r.employee.user.firstName || ''} ${r.employee.user.lastName || ''}`.trim() : (r.requestedBy ? `${r.requestedBy.firstName || ''} ${r.requestedBy.lastName || ''}`.trim() : 'Employee');
          const busy = busyId === r._id;
          return (
            <li key={r._id} className={`doc-req-row${busy ? ' is-busy' : ''}`}>
              <div className="doc-req-who">
                <PersonAvatar user={person} size="sm" />
                <div className="min-w-0">
                  <div className="doc-who-name">{who}</div>
                  {r.employee?.employeeCode && <div className="doc-who-code">{r.employee.employeeCode}</div>}
                </div>
              </div>
              <div className="doc-req-what">
                <div className="doc-file-tags">
                  <span className="doc-req-verb"><FiRefreshCw size={11} /> Replace</span>
                  <span className="doc-cat">{humanize(r.category)}</span>
                </div>
                <div className="doc-req-file" title={r.fileName || 'attached'}>
                  <FiPaperclip size={12} /> {r.fileName || 'attached'}
                </div>
                {r.reason && <div className="doc-req-reason">“{r.reason}”</div>}
              </div>
              <div className="doc-req-actions">
                <button type="button" disabled={busy} onClick={() => decide(r, 'approve')} className="trn-btn rg-approve doc-act">
                  {busy ? '…' : <><FiCheck size={14} /> Approve &amp; swap</>}
                </button>
                <button type="button" disabled={busy} onClick={() => decide(r, 'decline')} className="trn-btn doc-act">
                  Decline
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
