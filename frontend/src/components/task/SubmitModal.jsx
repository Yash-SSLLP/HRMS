/**
 * The form a task is handed back with (section 12).
 *
 * WHAT IT IS FOR, more than collecting files: telling somebody what this
 * particular task needs BEFORE they try to submit it. The requirements are
 * listed at the top as a live checklist that ticks itself as the form is filled
 * in, so "3 photos required" is visible while the photos are being attached
 * rather than after the Submit button has been pressed.
 *
 * THE SERVER STILL DECIDES. Everything checked here is checked again by
 * `missingRequirements` on the way in — a client-side check is a courtesy, not
 * a rule, and this one exists so the courtesy is a good one. When the server
 * does refuse, it names every missing thing at once, and that sentence is shown
 * as-is.
 *
 * LOCATION IS ASKED FOR VISIBLY. A task that captures or enforces location says
 * so on this form, with the reading shown once it is taken. Nothing in this
 * module ever takes a position without the person being able to see that it did.
 */
import { useEffect, useMemo, useState } from 'react';
import { FiX, FiCheck, FiUploadCloud, FiMapPin, FiAlertCircle, FiLoader } from 'react-icons/fi';
import { REQUIREMENT_LABELS } from '../../utils/taskLifecycle';
import { currentPosition } from '../../api/tasks';

const isImage = (f) => (f?.type || '').startsWith('image/');

/**
 * @param {object} props
 * @param {object} props.task
 * @param {(payload:object) => Promise<void>} props.onSubmit
 * @param {() => void} props.onClose
 */
export default function SubmitModal({ task, onSubmit, onClose }) {
  const need = task.requirements || {};
  const [remarks, setRemarks] = useState('');
  const [files, setFiles] = useState([]);
  const [urls, setUrls] = useState('');
  const [fieldValues, setFieldValues] = useState(() => Object.fromEntries(
    (task.customFields || []).map((f) => [f.key, f.value ?? ''])
  ));
  const [position, setPosition] = useState(null);
  const [locating, setLocating] = useState(false);
  const [locError, setLocError] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const wantsLocation = need.location || (task.location?.captureOn || []).includes('submit')
    || (task.location?.enforceOn || []).includes('submit');

  // Ask for the position as the form opens, when the task wants one. Asking on
  // Submit instead means a permission prompt appears at the moment somebody is
  // trying to finish, and a refusal then reads as the submission failing.
  useEffect(() => {
    if (!wantsLocation) return;
    let alive = true;
    setLocating(true);
    currentPosition().then((p) => {
      if (!alive) return;
      setPosition(p);
      if (!p) setLocError('Your browser did not give a location. Allow location access and press Retry.');
      setLocating(false);
    });
    return () => { alive = false; };
  }, [wantsLocation]);

  const photos = useMemo(() => files.filter(isImage), [files]);
  const others = useMemo(() => files.filter((f) => !isImage(f)), [files]);
  const urlList = useMemo(
    () => urls.split(/[\n,]/).map((u) => u.trim()).filter(Boolean),
    [urls]
  );

  // The live checklist. Each line answers itself as the form is filled in.
  const checks = useMemo(() => {
    const out = [];
    if (need.remarks) out.push({ key: 'remarks', label: REQUIREMENT_LABELS.remarks, done: !!remarks.trim() });
    if (need.checklist) {
      const undone = (task.checklist || []).filter((c) => c.mandatory !== false && !c.done);
      out.push({
        key: 'checklist',
        label: undone.length
          ? `${undone.length} checklist item${undone.length === 1 ? '' : 's'} still to tick`
          : REQUIREMENT_LABELS.checklist,
        done: undone.length === 0,
      });
    }
    if (need.photo) {
      const want = Math.max(1, need.minPhotos || 0);
      out.push({
        key: 'photo',
        label: want === 1 ? 'A photo' : `${want} photos (${photos.length} attached)`,
        done: photos.length >= want,
      });
    }
    if (need.attachment) {
      const want = Math.max(1, need.minAttachments || 0);
      const have = others.length + urlList.length;
      out.push({
        key: 'attachment',
        label: want === 1 ? 'An attachment' : `${want} attachments (${have} attached)`,
        done: have >= want,
      });
    }
    if (need.signature) out.push({ key: 'signature', label: REQUIREMENT_LABELS.signature, done: false });
    if (need.location) out.push({ key: 'location', label: REQUIREMENT_LABELS.location, done: !!position });
    for (const f of task.customFields || []) {
      if (!f.required) continue;
      out.push({ key: f.key, label: f.label || f.key, done: !!String(fieldValues[f.key] ?? '').trim() });
    }
    return out;
  }, [need, remarks, task.checklist, task.customFields, photos.length, others.length, urlList.length, position, fieldValues]);

  const allDone = checks.every((c) => c.done);

  const addFiles = (list) => {
    const incoming = Array.from(list || []);
    // 25 MB is the server's own per-file ceiling; catching it here saves an
    // upload that was always going to be refused.
    const tooBig = incoming.filter((f) => f.size > 25 * 1024 * 1024);
    if (tooBig.length) {
      setError(`${tooBig.map((f) => f.name).join(', ')} — too large. 25 MB is the limit per file.`);
    }
    setFiles((prev) => [...prev, ...incoming.filter((f) => f.size <= 25 * 1024 * 1024)].slice(0, 10));
  };

  const retryLocation = async () => {
    setLocating(true);
    setLocError('');
    const p = await currentPosition();
    setPosition(p);
    if (!p) setLocError('Still no location. Check that location is allowed for this site.');
    setLocating(false);
  };

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      await onSubmit({
        remarks,
        files,
        urls: urlList,
        fieldValues,
        location: position,
      });
    } catch (err) {
      setError(err.response?.data?.message || err.message || 'Could not submit');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-start justify-center px-4 z-50 overflow-y-auto py-8">
      <div className="bg-white rounded-xl shadow-lg w-full max-w-lg p-6">
        <div className="flex items-center justify-between mb-1">
          <h2 className="card-title">Submit for review</h2>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-600" aria-label="Close">
            <FiX size={18} />
          </button>
        </div>
        <p className="text-sm text-gray-500 mb-4">{task.title}</p>

        {/* What this task demands, ticking itself as the form is filled in. */}
        {checks.length > 0 && (
          <div className="mb-4 rounded-lg border border-gray-200 p-3">
            <div className="text-xs font-medium text-gray-500 mb-1.5">This task needs:</div>
            <ul className="space-y-1">
              {checks.map((c) => (
                <li key={c.key} className="flex items-center gap-2 text-sm">
                  <span className={`w-4 h-4 rounded-full flex items-center justify-center shrink-0 ${
                    c.done ? 'bg-green-500 text-white' : 'border border-gray-300'}`}>
                    {c.done && <FiCheck size={10} />}
                  </span>
                  <span className={c.done ? 'text-gray-500 line-through' : 'text-gray-800'}>{c.label}</span>
                </li>
              ))}
            </ul>
            {need.note && <p className="mt-2 text-xs text-gray-500 border-t border-gray-100 pt-2">{need.note}</p>}
          </div>
        )}

        <form onSubmit={submit} className="space-y-3">
          <div>
            <label className="block text-sm text-gray-700">
              Remarks{need.remarks && ' *'}
            </label>
            <textarea rows={3} value={remarks} onChange={(e) => setRemarks(e.target.value)}
              placeholder="What was done, and anything the reviewer should know"
              className="mt-1 block w-full border rounded-lg px-3 py-2" />
          </div>

          {(task.customFields || []).length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {task.customFields.map((f) => (
                <div key={f.key}>
                  <label className="block text-sm text-gray-700">{f.label || f.key}{f.required && ' *'}</label>
                  {f.type === 'select' ? (
                    <select value={fieldValues[f.key] ?? ''}
                      onChange={(e) => setFieldValues((v) => ({ ...v, [f.key]: e.target.value }))}
                      className="mt-1 block w-full border rounded-lg px-3 py-2">
                      <option value="">—</option>
                      {(f.options || []).map((o) => <option key={o} value={o}>{o}</option>)}
                    </select>
                  ) : (
                    <input type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'}
                      value={fieldValues[f.key] ?? ''}
                      onChange={(e) => setFieldValues((v) => ({ ...v, [f.key]: e.target.value }))}
                      className="mt-1 block w-full border rounded-lg px-3 py-2" />
                  )}
                </div>
              ))}
            </div>
          )}

          <div>
            <label className="block text-sm text-gray-700 mb-1">
              Evidence{(need.photo || need.attachment) && ' *'}
            </label>
            <label className="flex flex-col items-center justify-center gap-1 border-2 border-dashed border-gray-300 rounded-lg py-5 cursor-pointer hover:border-gray-400">
              <FiUploadCloud className="text-gray-400" size={22} />
              <span className="text-sm text-gray-500">Photos, video, documents — up to 10 files</span>
              <input type="file" multiple className="hidden"
                accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.csv,.txt"
                onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
            </label>
            {files.length > 0 && (
              <div className="mt-2 space-y-1">
                {files.map((f, i) => (
                  <div key={`${f.name}-${i}`} className="flex items-center gap-2 text-sm">
                    <span className="flex-1 truncate text-gray-700">{f.name}</span>
                    <span className="text-xs text-gray-400 tabular-nums shrink-0">
                      {(f.size / 1024 / 1024).toFixed(1)} MB
                    </span>
                    <button type="button" onClick={() => setFiles((p) => p.filter((_, j) => j !== i))}
                      className="text-gray-400 hover:text-red-600" aria-label="Remove">
                      <FiX size={14} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div>
            <label className="block text-sm text-gray-700">Links</label>
            <textarea rows={2} value={urls} onChange={(e) => setUrls(e.target.value)}
              placeholder="One per line, when the proof lives somewhere else"
              className="mt-1 block w-full border rounded-lg px-3 py-2 text-sm" />
          </div>

          {wantsLocation && (
            <div className={`rounded-lg border p-3 ${position ? 'border-gray-200' : 'border-amber-200 bg-amber-50'}`}>
              <div className="flex items-start gap-2">
                <FiMapPin className={position ? 'text-gray-400 mt-0.5' : 'text-amber-600 mt-0.5'} size={15} />
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-gray-800">
                    {locating ? 'Getting your location…'
                      : position ? 'Your location will be recorded with this submission'
                        : 'This task records where you are'}
                  </div>
                  {position && (
                    <div className="text-xs text-gray-500 mt-0.5 tabular-nums">
                      {position.lat.toFixed(5)}, {position.lng.toFixed(5)}
                      {position.accuracy ? ` · ±${position.accuracy} m` : ''}
                    </div>
                  )}
                  {locError && <div className="text-xs text-amber-700 mt-0.5">{locError}</div>}
                  {(task.location?.enforceOn || []).includes('submit') && (
                    <div className="text-xs text-gray-500 mt-1">
                      You need to be at the site to submit this one.
                    </div>
                  )}
                </div>
                {!locating && (
                  <button type="button" onClick={retryLocation}
                    className="text-xs px-2 py-1 border rounded-lg hover:bg-white shrink-0" style={{ minHeight: 30 }}>
                    {position ? 'Refresh' : 'Retry'}
                  </button>
                )}
                {locating && <FiLoader className="animate-spin text-gray-400 shrink-0" size={15} />}
              </div>
            </div>
          )}

          {error && (
            <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg flex gap-2">
              <FiAlertCircle className="shrink-0 mt-0.5" size={15} />
              <span>{error}</span>
            </div>
          )}

          {!allDone && checks.length > 0 && (
            <p className="text-xs text-amber-600">
              Some of what this task needs is still missing — you can submit once every line above is ticked.
            </p>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={onClose}
              className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50" style={{ minHeight: 40 }}>
              Cancel
            </button>
            <button type="submit" disabled={saving || !allDone}
              className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-50"
              style={{ minHeight: 40 }}>
              {saving ? 'Submitting…' : 'Submit'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
