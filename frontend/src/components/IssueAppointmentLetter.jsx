/**
 * IssueAppointmentLetter — issue an appointment letter to somebody who is
 * ALREADY an employee, from the employee page.
 *
 * The recruitment flow issues one to a CANDIDATE on the way in. This is for
 * everybody who was here before the portal, or who arrived through the bulk
 * import, and so has an employee record and no letter anywhere.
 *
 * WHY THE FIGURES ARE READ-ONLY HERE. What the letter states is derived from the
 * employee record — the annual CTC split by the assigned salary structure,
 * through payroll's own derivation — so the letter and the payslip cannot
 * disagree. A typeable CTC would let somebody produce a signed contract saying
 * one thing while payroll pays another, and the contract is the document that
 * wins that argument. If a figure is wrong, the employee record is what to fix,
 * and this panel links there.
 *
 * What IS editable is what the record has no opinion about: the working hours,
 * the probation and notice periods, and the wording itself.
 *
 * An incomplete record is refused by the server (422) with the missing fields
 * named, and that message is shown as-is: "this letter cannot be issued yet and
 * here is why" is more useful than a letter with blanks in it.
 *
 * Backend: POST /employees/:id/letters/appointment{,/draft,/preview}
 */
import { useEffect, useState } from 'react';
import { FiX, FiFileText, FiAlertTriangle } from 'react-icons/fi';
import { toast } from 'react-toastify';
import api from '../api/client';
import LetterEditor from './LetterEditor';
import ShiftHoursSelect from './ShiftHoursSelect';

const fmtDate = (d) =>
  (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');

const money = (n) => (Number(n) ? `₹${new Intl.NumberFormat('en-IN').format(Number(n))}` : '—');

/** One derived fact, shown but not editable. */
function Fact({ label, value }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] uppercase tracking-wide text-gray-400">{label}</dt>
      <dd className="text-sm text-gray-900 font-medium truncate">{value || '—'}</dd>
    </div>
  );
}

/**
 * @param {Object} profile - the employee profile being viewed
 * @param {() => void} onClose
 * @param {() => void} onIssued - refresh the document list
 */
export default function IssueAppointmentLetter({ profile, onClose, onIssued }) {
  const base = `/employees/${profile._id}/letters/appointment`;

  const [fields, setFields] = useState(null);
  const [blocked, setBlocked] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  // The letter-only values — everything else is derived and read-only.
  const [form, setForm] = useState({ workingHours: '', probationMonths: 3, noticePeriodDays: 30 });
  const [body, setBody] = useState(null);

  useEffect(() => {
    let live = true;
    api.post(`${base}/draft`, {})
      .then(({ data }) => {
        if (!live) return;
        setFields(data.fields);
        setForm((f) => ({
          ...f,
          probationMonths: data.fields.probationMonths ?? 3,
          noticePeriodDays: data.fields.noticePeriodDays ?? 30,
          workingHours: data.fields.workingHours || '',
        }));
      })
      .catch((err) => {
        if (!live) return;
        // A 422 is the record being incomplete, which is the thing HR most needs
        // to be told plainly. Anything else is a real failure.
        setBlocked(err.response?.data?.message || 'Could not prepare the letter.');
      })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const issue = async (replace = false) => {
    setBusy(true);
    try {
      const { data } = await api.post(base, { ...form, body: body || undefined, replace });
      toast.success(data.replaced
        ? 'Appointment letter re-issued — the previous one was replaced.'
        : 'Appointment letter issued and filed against the employee.');
      onIssued?.();
      onClose();
    } catch (err) {
      const res = err.response;
      // One already on file. Ask rather than overwrite a filed document.
      if (res?.status === 409) {
        // eslint-disable-next-line no-alert
        const ok = window.confirm(`${res.data?.message}\n\nReplace it with the new one?`);
        if (ok) { setBusy(false); return issue(true); }
      } else {
        toast.error(res?.data?.message || 'Could not issue the letter');
      }
    } finally {
      setBusy(false);
    }
    return undefined;
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[92vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-5 py-4 border-b border-gray-100">
          <FiFileText className="text-gray-400 shrink-0" size={18} />
          <h2 className="card-title flex-1 min-w-0 truncate">Issue appointment letter</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="p-1 rounded-md text-gray-400 hover:text-gray-700">
            <FiX size={18} />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4">
          {loading && <p className="text-sm text-gray-500">Preparing…</p>}

          {!loading && blocked && (
            <div className="flex gap-3 text-sm text-amber-900 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">
              <FiAlertTriangle className="shrink-0 mt-0.5" size={16} />
              <div>
                <p className="font-medium mb-1">This letter cannot be issued yet.</p>
                <p>{blocked}</p>
              </div>
            </div>
          )}

          {!loading && fields && (
            <>
              {/* Derived from the record — shown so HR can check it BEFORE the
                  letter exists, which is the point at which a wrong designation
                  is cheap to fix. */}
              <p className="text-[11px] text-gray-500 mb-3">
                Taken from the employee record. To change any of it, edit the employee and issue the letter after.
              </p>
              <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-3 mb-4 p-3 bg-gray-50 rounded-lg border border-gray-100">
                <Fact label="Name" value={fields.name} />
                <Fact label="Employee code" value={fields.employeeCode} />
                <Fact label="Designation" value={fields.designation} />
                <Fact label="Department" value={fields.department} />
                <Fact label="Place of work" value={fields.location} />
                <Fact label="Date of appointment" value={fmtDate(fields.joiningDate)} />
                <Fact label="Employment type" value={fields.employmentType} />
                <Fact label="Reporting to" value={fields.reportingManager || 'Department Head / CEO'} />
                <Fact label="Annual CTC" value={money(fields.ctcAnnual)} />
              </dl>
              {fields.structureName && (
                <p className="text-[11px] text-gray-500 -mt-2 mb-4">
                  Annexure I is derived from the “{fields.structureName}” salary structure, the same split payroll uses.
                </p>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="sm:col-span-3">
                  <label className="block text-xs text-gray-600 mb-1">Working hours / shift</label>
                  <ShiftHoursSelect
                    value={form.workingHours}
                    onChange={(v) => setForm({ ...form, workingHours: v })}
                    className="block w-full border rounded-lg px-3 py-2 bg-white"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-600 mb-1">Probation (months)</label>
                  <input type="number" min="0" value={form.probationMonths}
                    onChange={(e) => setForm({ ...form, probationMonths: e.target.value })}
                    className="block w-full border rounded-lg px-3 py-2" />
                </div>
                <div>
                  <label className="block text-xs text-gray-600 mb-1">Notice (days)</label>
                  <input type="number" min="0" value={form.noticePeriodDays}
                    onChange={(e) => setForm({ ...form, noticePeriodDays: e.target.value })}
                    className="block w-full border rounded-lg px-3 py-2" />
                </div>
              </div>

              <LetterEditor
                kind="appointment"
                basePath={base}
                form={form}
                value={body}
                onChange={setBody}
              />
            </>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-gray-100">
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm rounded-lg border border-gray-300 hover:bg-gray-50">
            Cancel
          </button>
          <button
            type="button"
            onClick={() => issue(false)}
            disabled={busy || loading || !!blocked}
            className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-50"
          >
            {busy ? 'Issuing…' : 'Issue and file it'}
          </button>
        </div>
      </div>
    </div>
  );
}
