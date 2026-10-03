/**
 * Advance report — the total each person was advanced over any dates, as .xlsx.
 *
 * Asked for 2026-09-28: "give option to download total advance taken by people
 * in any interval, for all people, for few people". The server does the sums
 * (GET /khata/reports/advances decides what counts as taken, handles reversals
 * and keeps the company wall); this dialog only asks which dates and whom.
 *
 * The people are the page's own `people` list (/khata/employee-options) — the
 * list every other picker on the cashbook page draws from, the CEO and MD
 * included. Admin logins are held back until searched for, as in those pickers.
 */
import { useMemo, useState } from 'react';
import { toast } from 'react-toastify';
import api from '../api/client';
import { saveBlobResponse } from '../utils/download';
import { toYMD } from '../utils/time';

const ymd = (y, m, d) => toYMD(new Date(y, m, d));

/** The quick ranges as [label, from, to], worked out from today. */
function quickRanges(now = new Date()) {
  const y = now.getFullYear();
  const m = now.getMonth();
  // The Indian financial year starts on 1 April.
  const fy = m >= 3 ? y : y - 1;
  return [
    ['This month', ymd(y, m, 1), toYMD(now)],
    ['Last month', ymd(y, m - 1, 1), ymd(y, m, 0)],
    ['Last 3 months', ymd(y, m - 2, 1), toYMD(now)],
    ['This financial year', ymd(fy, 3, 1), toYMD(now)],
  ];
}

/** A refusal arrives as a Blob (responseType is fixed before the status is known). */
async function messageFrom(err, fallback) {
  if (err.response?.status === 403) return 'You do not have permission to download the cashbook.';
  try {
    const text = err.response?.data instanceof Blob ? await err.response.data.text() : null;
    if (text) return JSON.parse(text).message || fallback;
  } catch { /* keep the fallback */ }
  return fallback;
}

/**
 * @param {{people: Object[], onClose: Function}} props - `people` as returned by
 *   /khata/employee-options: { _id, name, employeeCode, designation, systemAccount }
 */
export default function AdvanceReportModal({ people, onClose }) {
  const ranges = useMemo(() => quickRanges(), []);
  const [from, setFrom] = useState(ranges[0][1]);
  const [to, setTo] = useState(ranges[0][2]);
  const [who, setWho] = useState('all');
  const [picked, setPicked] = useState(() => new Set());
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return people.filter((p) => !p.systemAccount);
    return people.filter((p) => `${p.name} ${p.employeeCode || ''} ${p.designation || ''} ${p.email || ''}`
      .toLowerCase().includes(q));
  }, [people, query]);

  const toggle = (id) => setPicked((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const pickShown = () => setPicked((prev) => new Set([...prev, ...shown.map((p) => String(p._id))]));

  const badDates = !from || !to || from > to;
  const ready = !badDates && (who === 'all' || picked.size > 0);

  const download = async (e) => {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    try {
      const params = { from, to };
      if (who === 'some') params.employees = [...picked].join(',');
      const res = await api.get('/khata/reports/advances', { params, responseType: 'blob' });
      saveBlobResponse(res, `advance-totals_${from}_to_${to}.xlsx`);
      toast.success('Advance report downloaded');
      onClose();
    } catch (err) {
      toast.error(await messageFrom(err, 'Could not build the advance report'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4 overflow-y-auto">
      <form onSubmit={download} className="bg-white rounded-xl shadow-xl w-full max-w-lg p-5 my-8">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">Advance report</h3>

        <p className="block text-sm text-gray-700 mb-1">Dates</p>
        <div className="flex flex-wrap gap-2 mb-2">
          {ranges.map(([label, f, t]) => (
            <button key={label} type="button" onClick={() => { setFrom(f); setTo(t); }}
              className={`px-3 py-1 rounded-full border text-xs font-medium ${
                from === f && to === t ? 'border-gray-900 bg-gray-900 text-white' : 'border-gray-300 text-gray-700 hover:bg-gray-50'}`}>
              {label}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-3 mb-1">
          <label className="text-xs text-gray-500">
            From
            <input type="date" required value={from} max={to || undefined}
              onChange={(e) => setFrom(e.target.value)}
              className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-900" />
          </label>
          <label className="text-xs text-gray-500">
            To
            <input type="date" required value={to} min={from || undefined}
              onChange={(e) => setTo(e.target.value)}
              className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-900" />
          </label>
        </div>
        {badDates && from && to && (
          <p className="text-xs text-red-600 mb-1">The start date is after the end date.</p>
        )}

        <p className="block text-sm text-gray-700 mt-4 mb-1">People</p>
        <div className="flex flex-wrap gap-4 mb-2 text-sm text-gray-800">
          <label className="inline-flex items-center gap-2 cursor-pointer">
            <input type="radio" name="advance-who" checked={who === 'all'} onChange={() => setWho('all')} />
            Everyone
          </label>
          <label className="inline-flex items-center gap-2 cursor-pointer">
            <input type="radio" name="advance-who" checked={who === 'some'} onChange={() => setWho('some')} />
            Choose people
          </label>
        </div>

        {who !== 'all' && (
          <div className="border border-gray-200 rounded-lg">
            <div className="flex items-center gap-2 p-2 border-b border-gray-200">
              <input type="search" value={query} onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by name or code"
                className="flex-1 min-w-0 border border-gray-300 rounded-md px-2 py-1.5 text-sm" />
              <button type="button" onClick={pickShown} disabled={!shown.length}
                className="text-xs text-gray-700 hover:text-gray-900 hover:underline disabled:opacity-40 whitespace-nowrap">
                Select all{query ? ' shown' : ''}
              </button>
              <button type="button" onClick={() => setPicked(new Set())} disabled={!picked.size}
                className="text-xs text-gray-700 hover:text-gray-900 hover:underline disabled:opacity-40">
                Clear
              </button>
            </div>
            <ul className="max-h-64 overflow-y-auto divide-y divide-gray-100">
              {shown.length === 0 ? (
                <li className="px-3 py-6 text-center text-xs text-gray-500">Nobody matches that search.</li>
              ) : shown.map((p) => {
                const id = String(p._id);
                return (
                  <li key={id}>
                    <label className="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-gray-50">
                      <input type="checkbox" checked={picked.has(id)} onChange={() => toggle(id)} />
                      <span className="min-w-0">
                        <span className="block text-sm text-gray-900 truncate">
                          {p.name}{p.employeeCode ? ` (${p.employeeCode})` : ''}
                        </span>
                        {p.designation && <span className="block text-xs text-gray-500 truncate">{p.designation}</span>}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
            <p className="px-3 py-2 border-t border-gray-200 text-xs text-gray-600">
              {picked.size === 0 ? 'Tick the people to include.' : `${picked.size} chosen`}
            </p>
          </div>
        )}

        <div className="flex justify-end gap-2 mt-5">
          <button type="button" onClick={onClose}
            className="px-4 py-2 border border-gray-300 rounded-lg text-sm hover:bg-gray-50">Cancel</button>
          <button type="submit" disabled={!ready || busy}
            className="px-4 py-2 bg-gray-900 text-white rounded-lg text-sm hover:bg-gray-700 disabled:opacity-50">
            {busy ? 'Building…' : 'Download Excel'}
          </button>
        </div>
      </form>
    </div>
  );
}
