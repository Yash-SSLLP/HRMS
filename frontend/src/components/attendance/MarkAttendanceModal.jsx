/**
 * MarkAttendanceModal — a Super Admin puts in the punches of a day somebody
 * forgot to mark (user, 2026-10-07). POST /attendance/mark creates the day or
 * fills the one there is; it writes no remark and tells nobody, and the audit
 * log (Super Admin only) is its one trace — so the callers render this for a
 * Super Admin only, and nothing here mentions it to anyone else.
 *
 * Picking a person and a day loads what that day already holds, so the boxes
 * show the punches that are there (an auto-close's missing check-out, say)
 * rather than inviting a blind overwrite. Only boxes that differ from what was
 * loaded are sent.
 *
 * @prop {object[]} employees - EmployeeProfiles for the picker
 * @prop {string} [employee] - fix the person (Monthly View) instead of picking
 * @prop {string} [date] - 'YYYY-MM-DD' to open on
 * @prop {() => void} onClose
 * @prop {() => void} onSaved - after a successful save (reload the list)
 */
import { useEffect, useState } from 'react';
import { toast } from 'react-toastify';
import api from '../../api/client';
import SearchableSelect from '../SearchableSelect';
import { peopleOptions } from '../../utils/peopleOptions';
import { toYMD } from '../../utils/time';
import { punchState, changedPunches, dmy } from '../../utils/attendancePunch';
import PunchTimeFields from './PunchTimeFields';

const yesterday = () => toYMD(new Date(Date.now() - 86400000));

export default function MarkAttendanceModal({ employees = [], employee: fixedEmployee, date: initialDate, onClose, onSaved }) {
  const [form, setForm] = useState(() => ({
    employee: fixedEmployee || '',
    ...punchState(null, initialDate || yesterday()),
  }));
  const [existing, setExisting] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // What the chosen day already holds. A day with a record shows its punches;
  // an empty day keeps whatever was already typed.
  useEffect(() => {
    if (!form.employee || !form.date) { setExisting(null); return undefined; }
    let alive = true;
    const [y, m, d] = form.date.split('-').map(Number);
    const params = new URLSearchParams({ year: y, month: m, day: d, employee: form.employee });
    api.get(`/attendance?${params}`).then(({ data }) => {
      if (!alive) return;
      const rec = (data.records || [])[0] || null;
      setExisting(rec);
      setForm((f) => (rec
        ? { ...f, ...punchState(rec) }
        : { ...f, orig: punchState(null, f.date).orig }));
    }).catch(() => { if (alive) setExisting(null); });
    return () => { alive = false; };
  }, [form.employee, form.date]);

  const save = async (e) => {
    e.preventDefault();
    setError('');
    // Mark only adds or replaces times; emptying one is the edit's job.
    const punches = Object.fromEntries(
      Object.entries(changedPunches(form, { withDate: false })).filter(([, v]) => v),
    );
    if (!Object.keys(punches).length) {
      if (existing?.checkIn) { onClose(); return; }
      setError('Enter the check-in time.');
      return;
    }
    setSaving(true);
    try {
      const { data } = await api.post('/attendance/mark', { employee: form.employee, date: form.date, ...punches });
      toast.success(`${data.created ? 'Attendance marked' : 'Attendance updated'} · ${dmy(form.date)}`);
      onSaved?.();
      onClose();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not mark attendance');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50">
      <div className="bg-white rounded-xl shadow-lg w-full max-w-md p-6">
        <h2 className="card-title mb-4">Mark attendance</h2>
        <form onSubmit={save} className="space-y-3">
          {!fixedEmployee && (
            <div>
              <label className="block text-sm text-gray-700">Employee *</label>
              <SearchableSelect required value={form.employee}
                onChange={(e) => setForm((f) => ({ ...f, employee: e.target.value }))}
                className="mt-1 block w-full border rounded-lg px-3 py-2">
                <option value="">Select…</option>
                {peopleOptions(employees, (p) => `${p.employeeCode} · ${p.user?.firstName || ''} ${p.user?.lastName || ''}`, { keep: [form.employee] })}
              </SearchableSelect>
            </div>
          )}
          <div>
            <div className="flex items-center justify-between gap-2">
              <label htmlFor="mark-date" className="block text-sm text-gray-700">Date *</label>
              {existing && (
                <span className="text-[11px] px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">
                  {existing.noPunchOut ? 'No punch-out' : existing.status}
                </span>
              )}
            </div>
            <input id="mark-date" type="date" required max={toYMD(new Date())}
              value={form.date}
              onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))}
              className="mt-1 block w-full border rounded-lg px-3 py-2" />
          </div>

          <PunchTimeFields form={form} setForm={setForm} removable={false} idPrefix="mark" />

          {error && (
            <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose}
              className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">Cancel</button>
            <button type="submit" disabled={saving || !form.employee}
              className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60">
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
