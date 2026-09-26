import { useEffect, useState } from 'react';
import api from '../api/client';
import { FiChevronLeft, FiChevronRight, FiUmbrella } from 'react-icons/fi';
import { TbBeach, TbCalendarOff } from 'react-icons/tb';
import { useAuthStore } from '../store/authStore';

// "On leave" — every colleague away on a chosen day, today by default. Sits
// beside Birthdays & Celebrations on the employee dashboard and is shaped like
// it: the same row, avatar and "See all" behaviour, so the two read as a pair.
//
// The server decides who counts (GET /leave/on-leave — approved leave covering
// the day, minus days worked back, walled to the viewer's company) and answers
// with names and full/half day only. The leave TYPE and the reason are withheld
// on purpose: this card is shown to every employee.

// How many rows the card shows before "See all" is offered.
const PREVIEW_COUNT = 5;

// 'YYYY-MM-DD' for the IST calendar day — the key the server works in, so
// "today" here is the same day it is at the office, whatever the device clock's
// time zone says.
const istKey = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d);

// Move a day key by whole days. Done in UTC so no time zone can skip or repeat one.
function shiftKey(key, days) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

// Format a day key without letting the device's time zone move it to the day before.
const fmtKey = (key, opts) => new Date(`${key}T00:00:00Z`).toLocaleDateString('en-IN', { timeZone: 'UTC', ...opts });

function initials(name) {
  const parts = (name || '').trim().split(/\s+/);
  return ((parts[0]?.[0] || '') + (parts[1]?.[0] || '')).toUpperCase() || '?';
}

// "Today" / "Tomorrow" / "Yesterday", else the weekday and date.
function dayLabel(key, today) {
  if (key === today) return 'Today';
  if (key === shiftKey(today, 1)) return 'Tomorrow';
  if (key === shiftKey(today, -1)) return 'Yesterday';
  return fmtKey(key, { weekday: 'short', day: 'numeric', month: 'short' });
}

// A leave longer than the one day shown says how long it runs: "24 – 28 Sep".
function spanLabel(p) {
  if (!p.startDate || !p.endDate || p.startDate === p.endDate) return '';
  const sameMonth = p.startDate.slice(0, 7) === p.endDate.slice(0, 7);
  const from = fmtKey(p.startDate, sameMonth ? { day: 'numeric' } : { day: 'numeric', month: 'short' });
  return `${from} – ${fmtKey(p.endDate, { day: 'numeric', month: 'short' })}`;
}

// "Nobody is on leave tomorrow." / "Nobody was on leave on Mon, 21 Sep."
function emptyText(key, today, label) {
  const verb = key < today ? 'was' : 'is'; // day keys compare as strings
  if (label === 'Today' || label === 'Tomorrow' || label === 'Yesterday') {
    return `Nobody ${verb} on leave ${label.toLowerCase()}.`;
  }
  return `Nobody ${verb} on leave on ${label}.`;
}

const SESSION = { FirstHalf: '1st half', SecondHalf: '2nd half' };

export default function OnLeaveCard() {
  const me = useAuthStore((s) => s.user);
  const today = istKey();
  const [date, setDate] = useState(today);
  const [result, setResult] = useState(null); // { date, isToday, offDay, people }
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    // `live` drops the answer to a day the viewer has already stepped past, so
    // a slow reply can never paint yesterday's list under today's date.
    let live = true;
    setLoading(true);
    setFailed(false);
    setShowAll(false);
    api.get('/leave/on-leave', { params: { date } })
      .then(({ data }) => { if (live) setResult(data); })
      .catch(() => { if (live) { setResult(null); setFailed(true); } })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [date]);

  const people = result?.people || [];
  const visible = showAll ? people : people.slice(0, PREVIEW_COUNT);
  const hiddenCount = people.length - visible.length;
  const label = dayLabel(date, today);

  return (
    <div className="bg-white shadow rounded-lg p-5">
      <div className="flex items-center justify-between gap-2 mb-3">
        <h2 className="card-title flex items-center gap-2">
          <FiUmbrella className="text-sky-500 shrink-0" aria-hidden="true" />
          On leave
        </h2>
        {!loading && !failed && !result?.offDay && (
          <span className="text-xs text-gray-500">{people.length} away</span>
        )}
      </div>

      {/* Which day. Arrows step a day at a time; the field jumps anywhere —
          ahead is where it is most useful, to see who will be out. */}
      <div className="flex items-center gap-2 mb-4">
        <button
          type="button"
          onClick={() => setDate((d) => shiftKey(d, -1))}
          aria-label="Previous day"
          title="Previous day"
          className="shrink-0 p-1.5 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50"
        >
          <FiChevronLeft size={16} aria-hidden="true" />
        </button>
        <input
          type="date"
          value={date}
          onChange={(e) => { if (e.target.value) setDate(e.target.value); }}
          aria-label="Show who is on leave on this date"
          className="min-w-0 flex-1 border border-gray-200 rounded-lg px-2 py-1 text-sm text-gray-700"
        />
        <button
          type="button"
          onClick={() => setDate((d) => shiftKey(d, 1))}
          aria-label="Next day"
          title="Next day"
          className="shrink-0 p-1.5 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50"
        >
          <FiChevronRight size={16} aria-hidden="true" />
        </button>
        {date !== today && (
          <button
            type="button"
            onClick={() => setDate(today)}
            className="shrink-0 text-xs font-medium text-gray-600 hover:text-gray-900 px-2 py-1.5 rounded-lg border border-gray-200 hover:bg-gray-50"
          >
            Today
          </button>
        )}
      </div>

      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => <div key={i} className="skeleton h-14 rounded-lg" />)}
        </div>
      ) : failed ? (
        <p className="text-sm text-gray-500 italic">Could not load who is on leave. Try again in a moment.</p>
      ) : result?.offDay ? (
        <div className="text-center py-6">
          <TbCalendarOff size={30} className="mx-auto mb-1.5 text-gray-400" aria-hidden="true" />
          <p className="text-sm text-gray-500">
            {result.offDay.kind === 'sunday' ? 'Sunday — a weekly off.' : `Holiday — ${result.offDay.label}.`}
          </p>
          <p className="text-xs text-gray-400 mt-0.5">Nobody is scheduled to work.</p>
        </div>
      ) : people.length === 0 ? (
        <div className="text-center py-6">
          <TbBeach size={30} className="mx-auto mb-1.5 text-gray-400" aria-hidden="true" />
          <p className="text-sm text-gray-500 italic">{emptyText(date, today, label)}</p>
        </div>
      ) : (
        <>
          <ul className={`space-y-2${showAll ? ' max-h-96 overflow-y-auto pr-1' : ''}`}>
            {visible.map((p) => {
              const isMe = !!me?._id && String(p.userId) === String(me._id);
              const span = spanLabel(p);
              return (
                <li key={p.profileId} className="rounded-lg border border-gray-100 bg-gray-50/60 p-3">
                  {/* Wraps like the celebrations rows: on a narrow card the span
                      drops under the name instead of crushing it. */}
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="avatar-circle text-white bg-sky-500">{initials(p.name)}</span>
                    <div className="min-w-0 flex-1 basis-36">
                      <div className="text-sm font-medium text-gray-900 flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="truncate min-w-0 max-w-full">{p.name}</span>
                        <span className={`shrink-0 inline-block px-2 py-0.5 text-[11px] rounded-full ${p.isHalfDay ? 'bg-amber-100 text-amber-800' : 'bg-sky-100 text-sky-800'}`}>
                          {p.isHalfDay ? `Half day${SESSION[p.halfDaySession] ? ` · ${SESSION[p.halfDaySession]}` : ''}` : 'Full day'}
                        </span>
                      </div>
                      <div className="text-xs text-gray-500 truncate">
                        {p.designation || '-'}{p.department ? ` · ${p.department}` : ''}
                      </div>
                    </div>
                    {(isMe || span) && (
                      <span className="text-xs text-gray-500 shrink-0 ml-auto">
                        {isMe ? <span className="italic">That&apos;s you</span> : span}
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          {(hiddenCount > 0 || showAll) && (
            <button
              type="button"
              onClick={() => setShowAll((v) => !v)}
              className="mt-3 w-full text-center text-xs font-medium text-gray-600 hover:text-gray-900 py-1.5 rounded-lg border border-gray-200 hover:bg-gray-50"
            >
              {showAll ? 'Show less' : `See all ${people.length}`}
            </button>
          )}
        </>
      )}
    </div>
  );
}
