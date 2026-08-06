/**
 * EmployeeRegularizations — attendance-correction requests (employee portal).
 * Lists the user's requests from GET /regularizations/me and submits new ones
 * via POST /regularizations. Approval is done by HR/manager on the admin side.
 *
 * The date field is an AttendanceDatePicker: its calendar colours each day by
 * the state of that day's punches, and picking one hands back the record — so
 * the employee sees what attendance actually says (and which punch is missing)
 * before asking for a correction, and the existing times prefill the request.
 */
import { useEffect, useRef, useState } from 'react';
import api from '../api/client';
import PageHeader from '../components/PageHeader';
import AttendanceDatePicker from '../components/AttendanceDatePicker';
import { formatTime12, formatHours, formatDuration, toHM } from '../utils/time';

// Which punch each request type is about — drives which time fields the form
// shows, and the nudge under them. A type that concerns exactly one punch asks
// for exactly that one; the other field is hidden and cleared, and an empty
// requested time leaves that punch untouched when HR approves.
const TYPE_FIELDS = {
  'Missing Punch': { in: true, out: true, hint: 'Fill in whichever punch is missing.' },
  'Wrong Time': { in: true, out: true, hint: 'Enter the correct times for this day.' },
  'Forgot Check-in': { in: true, out: false, hint: 'Enter the time you actually started.' },
  'Forgot Check-out': { in: false, out: true, hint: 'Enter the time you actually left.' },
  'On Duty': { in: true, out: true, hint: 'Enter the hours you worked off-site.' },
  'Other': { in: true, out: true, hint: '' },
};

const TYPES = Object.keys(TYPE_FIELDS);

const STATUS_STYLES = {
  Pending: 'bg-amber-100 text-amber-800',
  Approved: 'bg-green-100 text-green-800',
  Rejected: 'bg-red-100 text-red-800',
};

// Attendance-day statuses shown in the picked-day summary (distinct from the
// request statuses above).
const DAY_STATUS_STYLES = {
  Present: 'bg-green-100 text-green-800',
  Absent: 'bg-red-100 text-red-800',
  HalfDay: 'bg-amber-100 text-amber-800',
  WeeklyOff: 'bg-gray-100 text-gray-700',
  Holiday: 'bg-blue-100 text-blue-800',
  OnLeave: 'bg-purple-100 text-purple-800',
};

const emptyForm = {
  date: '',
  type: 'Other',
  requestedCheckIn: '',
  requestedCheckOut: '',
  reason: '',
};

// The picked day's attendance: 'idle' (no date yet) | 'loading' | 'ready' | 'error'.
const emptyDay = { state: 'idle', record: null };

// One punch of the picked day. A missing punch is called out in red — that is
// usually the whole reason the employee is here.
const Punch = ({ label, value }) => (
  <div>
    <div className="text-xs text-gray-500">{label}</div>
    {value ? (
      <div className="font-medium text-gray-900">{formatTime12(value)}</div>
    ) : (
      <div className="font-medium text-red-600">Not recorded</div>
    )}
  </div>
);

/**
 * What attendance actually says for the date the employee picked, shown under
 * the Date field so the request can be filed against the real record.
 */
function DaySummary({ day }) {
  if (day.state === 'idle') return null;

  if (day.state === 'loading') {
    return <div className="mt-2 skeleton h-12 rounded-lg" />;
  }

  if (day.state === 'error') {
    return (
      <div className="mt-2 text-xs text-gray-500">
        Couldn&apos;t load this day&apos;s attendance — you can still submit the request.
      </div>
    );
  }

  const r = day.record;
  if (!r) {
    // A Sunday or a declared holiday has no record because nobody worked it —
    // that is not a gap to fix, so it must not read like one.
    if (day.off) {
      return (
        <div className="mt-2 text-sm px-3 py-2 rounded-lg border adp-offnote">
          {day.off} — nothing recorded, so there is usually nothing to regularize.
        </div>
      );
    }
    return (
      <div className="mt-2 text-sm text-amber-800 bg-amber-50 border border-amber-200 px-3 py-2 rounded-lg">
        No attendance record for this day — both punches are missing.
      </div>
    );
  }

  return (
    <div className="mt-2 border border-gray-200 bg-gray-50 rounded-lg px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">
          Recorded attendance{day.off ? ` · ${day.off}` : ''}
        </span>
        {r.status && (
          <span className={`inline-block px-2 py-0.5 text-xs rounded-lg ${DAY_STATUS_STYLES[r.status] || 'bg-gray-100 text-gray-700'}`}>
            {r.status}
          </span>
        )}
      </div>
      <div className="mt-1.5 grid grid-cols-2 gap-3 text-sm">
        <Punch label="Check-in" value={r.checkIn} />
        <Punch label="Check-out" value={r.checkOut} />
      </div>
      <div className="mt-1.5 text-xs text-gray-500 flex flex-wrap gap-x-3">
        <span>Worked: {formatHours(r.hoursWorked)}</span>
        {r.lateMinutes > 0 && <span className="text-amber-700">Late by {formatDuration(r.lateMinutes)}</span>}
        {r.noPunchOut && <span className="text-red-600">Auto-closed (no punch-out)</span>}
      </div>
    </div>
  );
}

export default function EmployeeRegularizations() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [day, setDay] = useState(emptyDay);
  // Time fields the employee has typed into: prefill never overwrites those.
  const touched = useRef({ in: false, out: false });

  // Which time fields the chosen request type asks for.
  const fields = TYPE_FIELDS[form.type] || TYPE_FIELDS.Other;

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const { data } = await api.get('/regularizations/me');
      setItems(data.items);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  // The picker already holds the whole month, so it hands the record over with
  // the date — no second fetch. A time the employee typed themselves survives a
  // date change; anything that was merely prefilled from the old day is redone.
  const pickDate = (ymd, info) => {
    const record = info?.record || null;
    setForm((f) => {
      const scope = TYPE_FIELDS[f.type] || TYPE_FIELDS.Other;
      return {
        ...f,
        date: ymd,
        requestedCheckIn: scope.in && !touched.current.in ? toHM(record?.checkIn) : f.requestedCheckIn,
        requestedCheckOut: scope.out && !touched.current.out ? toHM(record?.checkOut) : f.requestedCheckOut,
      };
    });
    setDay(ymd ? (info || { state: 'ready', record: null }) : emptyDay);
  };

  // Switching type re-scopes the time fields: one that no longer applies is
  // cleared, and one that comes back is prefilled from the day's record again.
  const pickType = (type) => {
    const f = TYPE_FIELDS[type] || TYPE_FIELDS.Other;
    if (!f.in) touched.current.in = false;
    if (!f.out) touched.current.out = false;
    const rec = day.record;
    setForm((prev) => ({
      ...prev,
      type,
      requestedCheckIn: f.in ? (touched.current.in ? prev.requestedCheckIn : toHM(rec?.checkIn)) : '',
      requestedCheckOut: f.out ? (touched.current.out ? prev.requestedCheckOut : toHM(rec?.checkOut)) : '',
    }));
  };

  // Reset the whole form (modal open/cancel/submit) including the day summary.
  const resetForm = () => {
    touched.current = { in: false, out: false };
    setForm(emptyForm);
    setDay(emptyDay);
  };

  const openModal = () => { resetForm(); setError(''); setShowModal(true); };
  const closeModal = () => { setShowModal(false); resetForm(); };

  const submit = async (e) => {
    e.preventDefault();
    if (!form.date) { setError('Pick the date you want corrected.'); return; }
    setSaving(true);
    setError('');
    try {
      await api.post('/regularizations', form);
      setShowModal(false);
      resetForm();
      await load();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not submit request');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="Attendance Regularization"
        subtitle="Request a correction for a missing or wrong attendance punch."
      >
        <button onClick={openModal}
          className="px-4 py-2 bg-gray-900 text-white rounded-lg hover:bg-gray-700 text-sm">
          + New Request
        </button>
      </PageHeader>

      {error && (
        <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>
      )}

      <div className="bg-white shadow rounded-lg overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Date</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Type</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Requested times</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Reason</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr><td colSpan={5} className="px-4 py-4"><div className="space-y-2.5"><div className="skeleton h-4 rounded" /><div className="skeleton h-4 rounded w-5/6" /><div className="skeleton h-4 rounded w-2/3" /></div></td></tr>
            ) : items.length === 0 ? (
              <tr><td colSpan={5} className="px-4 py-6 text-center text-gray-500">No regularization requests</td></tr>
            ) : items.map((r) => (
              <tr key={r._id}>
                <td className="px-4 py-3 text-gray-700">{new Date(r.date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}</td>
                <td className="px-4 py-3">{r.type}</td>
                <td className="px-4 py-3 text-gray-700">
                  {formatTime12(r.requestedCheckIn) || '-'} – {formatTime12(r.requestedCheckOut) || '-'}
                </td>
                <td className="px-4 py-3">
                  {r.reason}
                  {r.reviewNote && (
                    <div className="text-xs text-gray-500 mt-1">Note: {r.reviewNote}</div>
                  )}
                </td>
                <td className="px-4 py-3">
                  <span className={`inline-block px-2 py-0.5 text-xs rounded-lg ${STATUS_STYLES[r.status]}`}>
                    {r.status}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50 overflow-y-auto py-8">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-lg p-6">
            <h2 className="card-title mb-4">New Regularization Request</h2>
            <form onSubmit={submit} className="space-y-3">
              <div>
                <label className="block text-sm text-gray-700">Date *</label>
                <AttendanceDatePicker value={form.date} onChange={pickDate} />
                <DaySummary day={day} />
              </div>
              <div>
                <label className="block text-sm text-gray-700">Type</label>
                <select value={form.type}
                  onChange={(e) => pickType(e.target.value)}
                  className="mt-1 block w-full border rounded-lg px-3 py-2">
                  {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {fields.in && (
                    <div>
                      <label className="block text-sm text-gray-700">
                        Requested check-in{fields.in && !fields.out ? ' *' : ''}
                      </label>
                      <input type="time" value={form.requestedCheckIn} required={fields.in && !fields.out}
                        onChange={(e) => { touched.current.in = true; setForm({ ...form, requestedCheckIn: e.target.value }); }}
                        className="mt-1 block w-full border rounded-lg px-3 py-2" />
                    </div>
                  )}
                  {fields.out && (
                    <div>
                      <label className="block text-sm text-gray-700">
                        Requested check-out{fields.out && !fields.in ? ' *' : ''}
                      </label>
                      <input type="time" value={form.requestedCheckOut} required={fields.out && !fields.in}
                        onChange={(e) => { touched.current.out = true; setForm({ ...form, requestedCheckOut: e.target.value }); }}
                        className="mt-1 block w-full border rounded-lg px-3 py-2" />
                    </div>
                  )}
                </div>
                {fields.hint && <p className="mt-1 text-xs text-gray-500">{fields.hint}</p>}
              </div>
              <div>
                <label className="block text-sm text-gray-700">Reason *</label>
                <textarea required value={form.reason} rows={4} maxLength={2000}
                  onChange={(e) => setForm({ ...form, reason: e.target.value })}
                  className="mt-1 block w-full border rounded-lg px-3 py-2" />
              </div>
              {error && (
                <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>
              )}
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={closeModal}
                  className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">Cancel</button>
                <button type="submit" disabled={saving}
                  className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60">
                  {saving ? 'Submitting…' : 'Submit'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
