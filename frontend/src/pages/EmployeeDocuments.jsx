/**
 * EmployeeDocuments — the logged-in employee's document vault (employee portal).
 * Loads documents + category config from GET /documents/me and
 * GET /documents/categories, self-uploads files via POST /documents/me
 * (one file per request), and downloads/deletes via /documents/:id. HR-only
 * categories (offer letter, appraisal, etc.) are read-only here.
 *
 * Replacing splits in two on the server's rule (documentController): until HR
 * has VERIFIED a document the employee swaps it themselves — re-uploading into
 * the category supersedes what is there — and only a verified one needs a
 * request HR approves. Both start from the same Replace button, so the prompt
 * has to say which of the two is about to happen.
 */
import { useEffect, useRef, useState } from 'react';
import { toast } from 'react-toastify';
import api from '../api/client';
import { downloadFile } from '../api/download';
import PageHeader from '../components/PageHeader';
import { confirmDialog, promptDialog } from '../components/dialogs';
import SearchableSelect from '../components/SearchableSelect';
import { docLabel } from '../utils/docCategories';

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

// Category names come from utils/docCategories, topped up with whatever the
// server sent on /documents/categories: "PassportPhoto" is asked for as a
// Passport Size Photo, which no camelCase split can know.

const humanize = (c) => docLabel(c);

// Mirrors the ceiling on the server's document route (backend/routes/documentRoutes.js).
// Kept in step by hand: the two must agree or the client either blocks a file the
// server would take, or lets through one it will abort mid-stream.
const MAX_UPLOAD_MB = 10;

export default function EmployeeDocuments() {
  const [docs, setDocs] = useState([]);
  const [categories, setCategories] = useState([]);
  const [hrOnly, setHrOnly] = useState([]);
  // What is still outstanding, as the SERVER works it out. A waived requirement
  // and a relieving letter standing in for an experience letter are one rule and
  // it lives in models/Document.js — this page filtering `required` itself is how
  // the page and the HR list would come to disagree about the same person.
  const [missing, setMissing] = useState([]);
  const [labels, setLabels] = useState({});
  // Categories that hold SEVERAL files, where an upload adds rather than
  // replaces — so the overwrite warning below must stay quiet for them.
  const [multi, setMulti] = useState([]);
  // { ExperienceLetter: 'firstJob', ... } — which declaration answers which
  // requirement, so the page never hard-codes the pairing.
  const [waivable, setWaivable] = useState({});
  // { firstJob, noOtherDocuments } — an ANSWER to a requirement, not a file.
  const [declarations, setDeclarations] = useState({});
  const [savingDecl, setSavingDecl] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [category, setCategory] = useState('');
  const [note, setNote] = useState('');
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef(null);

  // Load my documents + the category config (self-upload, HR-only, required).
  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const [docsRes, catRes] = await Promise.all([
        api.get('/documents/me'),
        api.get('/documents/categories'),
      ]);
      setDocs(docsRes.data.documents);
      setMissing(docsRes.data.missing || []);
      setDeclarations(docsRes.data.declarations || {});
      setCategories(catRes.data.selfUpload || []);
      setHrOnly(catRes.data.hrOnly || []);
      setLabels(catRes.data.labels || {});
      setMulti(catRes.data.multi || []);
      setWaivable(catRes.data.waivable || {});
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
    const list = Array.from(fileRef.current?.files || []);
    if (!list.length) {
      setError('Please choose a file first');
      return;
    }
    // Checked here, before a byte is sent. Multer enforces the same ceiling, but
    // it aborts the request the moment the limit trips WITHOUT draining what the
    // browser is still sending — so the socket is torn down mid-upload and the
    // client sees "Network Error" with no message rather than the server's
    // perfectly good explanation. Refusing up front is the only way the person
    // actually gets told why.
    const tooBig = list.filter((f) => f.size > MAX_UPLOAD_MB * 1024 * 1024);
    if (tooBig.length) {
      setError(`${tooBig.map((f) => f.name).join(', ')} — over ${MAX_UPLOAD_MB} MB. Please attach a smaller copy.`);
      return;
    }
    setUploading(true);
    setError('');
    try {
      // The endpoint takes one file per request; upload each selected file so a
      // category like Experience Letter can hold several at once.
      for (const file of list) {
        const formData = new FormData();
        formData.append('file', file);
        formData.append('category', category);
        if (note) formData.append('note', note);
        await api.post('/documents/me', formData, {
          headers: { 'Content-Type': 'multipart/form-data' },
        });
      }
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

  // Answer a requirement instead of filing it. Only the one switch is sent, so
  // the two cannot overwrite each other, and the server answers with the new
  // outstanding list rather than this page guessing at it.
  const setDeclaration = async (field, value) => {
    setSavingDecl(true);
    try {
      const { data } = await api.patch('/documents/me/declarations', { [field]: value });
      setDeclarations(data.declarations || {});
      setMissing(data.missing || []);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not save that');
    } finally {
      setSavingDecl(false);
    }
  };

  // Replace a document: pick the new file, give a reason, and either swap it
  // outright or send it to HR — decided off the status, because a document HR
  // has already verified is the only one whose change is theirs to approve.
  // Uses a hidden file input.
  const replaceRef = useRef(null);
  const [replaceDoc, setReplaceDoc] = useState(null);
  const startReplace = (d) => { setReplaceDoc(d); setTimeout(() => replaceRef.current?.click(), 0); };
  const onReplaceFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    const d = replaceDoc;
    setReplaceDoc(null);
    if (!file || !d) return;
    if (file.size > MAX_UPLOAD_MB * 1024 * 1024) {
      toast.error(`${file.name} — over ${MAX_UPLOAD_MB} MB. Please attach a smaller copy.`);
      return;
    }
    const direct = d.status !== 'Verified';
    const reason = (await promptDialog({
      message: direct
        ? `Replace your ${humanize(d.category)} with "${file.name}"? HR has not verified it yet, so the new file takes effect straight away. Note for HR (optional):`
        : `Why replace your ${humanize(d.category)}? HR verified it, so the swap needs their approval. (optional)`,
    }));
    // promptDialog resolves null on cancel. It has to STOP here, not fall
    // through with an empty note: on the direct path the next line overwrites
    // the file the person was still deciding about.
    if (reason === null || reason === undefined) return;
    try {
      const fd = new FormData();
      fd.append('file', file);
      if (reason) fd.append('note', reason);
      if (direct) {
        // The same endpoint a first upload uses. `replaces` names THIS row: a
        // category can hold several files (a letter per past employer, anything
        // under Other), and replacing one must not clear the rest.
        fd.append('category', d.category);
        fd.append('replaces', d._id);
        await api.post('/documents/me', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
        toast.success('Document replaced. HR will verify the new file.');
      } else {
        await api.post(`/documents/me/${d._id}/replace-request`, fd, { headers: { 'Content-Type': 'multipart/form-data' } });
        toast.success('Replacement sent to HR for approval.');
      }
      await load();
    } catch (err) {
      toast.error(err.response?.data?.message || (direct ? 'Could not replace the document' : 'Could not send replacement request'));
    }
  };

  const onDelete = async (d) => {
    if (!(await confirmDialog({ message: 'This cannot be undone.', title: `Delete "${d.fileName}"?`, tone: 'danger', confirmText: 'Delete' }))) return;
    try {
      await api.delete(`/documents/${d._id}`);
      await load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Delete failed');
    }
  };

  return (
    <div>
      <PageHeader title="My Documents" />
      <input ref={replaceRef} type="file" hidden accept=".pdf,image/*,.doc,.docx" onChange={onReplaceFile} />

      {error && (
        <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>
      )}

      {/* Missing required documents — prompt the employee to upload what's pending. */}
      {(() => {
        if (loading) return null;
        if (missing.length === 0) {
          return docs.length > 0 ? (
            <div className="mb-6 rounded-lg border border-green-200 bg-green-50 px-4 py-2.5 text-sm text-green-800">
              ✓ All required documents submitted.
            </div>
          ) : null;
        }
        const missingSelf = missing.filter((c) => categories.includes(c));
        // Which of the outstanding ones can be ANSWERED rather than uploaded — the
        // panel points at the tick boxes only when one of them would actually help.
        const waivableMissing = missing.filter((c) => Object.keys(waivable).includes(c));
        const missingHr = missing.filter((c) => hrOnly.includes(c));
        return (
          <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50 p-4">
            <div className="text-sm font-semibold text-amber-900">Documents to submit ({missing.length})</div>
            <p className="text-xs text-amber-800 mt-0.5">
              Please upload the required documents below{missingHr.length ? ' - items marked “HR” are added for you by HR' : ''}.
              {waivableMissing.length ? ' If one of these does not exist for you, say so below instead of uploading it.' : ''}
            </p>
            <div className="flex flex-wrap gap-2 mt-2.5">
              {missingSelf.map((c) => (
                <button key={c} type="button"
                  onClick={() => { setCategory(c); fileRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }}
                  className="text-xs px-2.5 py-1 rounded-lg bg-white border border-amber-300 text-amber-900 hover:bg-amber-100">
                  {humanize(c)} <span className="text-amber-500 font-medium">＋ upload</span>
                </button>
              ))}
              {missingHr.map((c) => (
                <span key={c} className="text-xs px-2.5 py-1 rounded-lg bg-white border border-gray-200 text-gray-500">{humanize(c)} · HR</span>
              ))}
            </div>
          </div>
        );
      })()}

      {/* Two requirements a person can legitimately have nothing to put against.
          They live in the upload card, not the amber panel, because the panel
          disappears once nothing is outstanding — and un-ticking a box you ticked
          by mistake has to stay possible. */}
      <div className="bg-white shadow rounded-lg p-5 mb-6">
        <h2 className="card-title mb-1">Nothing to submit for these?</h2>
        <p className="text-xs text-gray-500 mb-3">
          Tick a box and that document stops being asked of you. HR can see what you
          said and when. Un-tick it any time.
        </p>
        <label className="flex items-start gap-2 text-sm text-gray-800 mb-2 cursor-pointer">
          <input type="checkbox" className="mt-0.5" disabled={savingDecl}
            checked={!!declarations.firstJob}
            onChange={(e) => setDeclaration('firstJob', e.target.checked)} />
          <span>
            <span className="font-medium">This is my first job.</span>{' '}
            <span className="text-gray-600">I have no {humanize('ExperienceLetter')} from a previous employer.</span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm text-gray-800 cursor-pointer">
          <input type="checkbox" className="mt-0.5" disabled={savingDecl}
            checked={!!declarations.noOtherDocuments}
            onChange={(e) => setDeclaration('noOtherDocuments', e.target.checked)} />
          <span>
            <span className="font-medium">I have no other documents to submit.</span>{' '}
            <span className="text-gray-600">Nothing beyond the ones listed above.</span>
          </span>
        </label>
      </div>

      <div className="bg-white shadow rounded-lg p-5 mb-6">
        <h2 className="card-title mb-3">Upload a document</h2>
        <form onSubmit={onUpload} className="space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div>
              <label className="block text-sm text-gray-700">Category</label>
              <SearchableSelect value={category} onChange={(e) => setCategory(e.target.value)}
                className="mt-1 block w-full border rounded-lg px-3 py-2">
                {categories.map((c) => <option key={c} value={c}>{humanize(c)}</option>)}
              </SearchableSelect>
            </div>
            <div className="md:col-span-2">
              <label className="block text-sm text-gray-700">{`File (PDF / JPG / PNG / DOCX, max ${MAX_UPLOAD_MB} MB) - you can select several`}</label>
              <input ref={fileRef} type="file" required multiple
                accept=".pdf,image/*,.doc,.docx"
                className="mt-1 block w-full text-sm" />
            </div>
          </div>
          <div>
            <label className="block text-sm text-gray-700">Note (optional)</label>
            <input value={note} onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. PAN card front side"
              className="mt-1 block w-full border rounded-lg px-3 py-2" />
          </div>
          {/* Uploading into a category that already holds an unverified copy
              REPLACES it (the server supersedes it), so say so before the file
              goes rather than letting the old one vanish unannounced. */}
          {!multi.includes(category) && docs.some((d) => d.category === category && d.status !== 'Verified') && (
            <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              You already have a {humanize(category)} awaiting verification — uploading here replaces it.
            </p>
          )}
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
              <tr><td colSpan={6} className="px-4 py-4"><div className="space-y-2.5"><div className="skeleton h-4 rounded" /><div className="skeleton h-4 rounded w-5/6" /><div className="skeleton h-4 rounded w-2/3" /></div></td></tr>
            ) : docs.length === 0 ? (
              <tr><td colSpan={6} className="px-4 py-6 text-center text-gray-500">No documents yet</td></tr>
            ) : docs.map((d) => {
              // Locked means VERIFIED: HR has signed that copy off, so changing it
              // is their decision. Anything short of that the employee replaces
              // themselves. HR-managed categories are read-only here entirely.
              const isOwnCategory = !hrOnly.includes(d.category);
              const canDelete = isOwnCategory && d.status === 'Rejected';
              const locked = isOwnCategory && d.status === 'Verified';
              const canReplace = isOwnCategory && !locked;
              return (
                <tr key={d._id}>
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
                    <button onClick={() => onDownload(d)} className="text-blue-600 hover:underline">Download</button>
                    {canReplace && (
                      <button onClick={() => startReplace(d)} className="text-indigo-600 hover:underline"
                        title="HR has not verified this yet, so your new file replaces it straight away.">Replace</button>
                    )}
                    {canDelete && (
                      <button onClick={() => onDelete(d)} className="text-red-600 hover:underline">Delete</button>
                    )}
                    {locked && (
                      <>
                        <span className="text-gray-400" title="HR has verified this document, so changing it needs their approval.">🔒 Locked</span>
                        <button onClick={() => startReplace(d)} className="text-indigo-600 hover:underline">Request replacement</button>
                      </>
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
