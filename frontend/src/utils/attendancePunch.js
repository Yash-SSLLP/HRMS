/**
 * Punch times as the attendance edit and mark forms handle them — one copy for
 * Admin → Attendance and the Monthly View, so the two cannot disagree about
 * which day a typed "10:00" lands on.
 *
 * The punches are edited as clock times on the record's own day — the Date box
 * — rather than as full date-times, so a correction cannot land on a different
 * day by a slip in the date half (user, 2026-10-07: "date is not need there").
 * A punch that sits on the NEXT calendar day (an overnight close) keeps that
 * offset, so re-saving it does not drag it back before the check-in.
 * All in the browser's local time, which for this portal is IST — the clock the
 * punch was made on and the one every other screen prints.
 */
import { toHM, toYMD } from './time';

/** Whole calendar days from `ymd` to the day a stored punch falls on (0, or 1 overnight). */
export const dayOffset = (punch, ymd) => {
  if (!punch || !ymd) return 0;
  const p = new Date(punch);
  const [y, m, d] = ymd.split('-').map(Number);
  return Math.round(
    (new Date(p.getFullYear(), p.getMonth(), p.getDate()) - new Date(y, m - 1, d)) / 86400000,
  );
};

/** 'YYYY-MM-DD' + 'HH:mm' (+ days) → an ISO instant for the server; '' → null (clear it). */
export const punchAt = (ymd, hm, offset = 0) => {
  if (!hm || !ymd) return null;
  const [y, m, d] = ymd.split('-').map(Number);
  const [h, mi] = hm.split(':').map(Number);
  return new Date(y, m - 1, d + offset, h, mi).toISOString();
};

/**
 * A record's day and punches as the forms hold them, plus `orig` — the same
 * values as loaded, which is what "changed" and Undo are measured against.
 * toYMD, not date.slice(0, 10): the day is stored as IST midnight, 18:30 UTC
 * the evening before, so slicing the ISO string named the previous day.
 * @param {object} [r] - an attendance record, or nothing for an empty day
 * @param {string} [ymd] - the day to use when there is no record
 */
export function punchState(r, ymd = '') {
  const date = r ? toYMD(r.date) : ymd;
  const orig = {
    date,
    checkIn: toHM(r?.checkIn),
    checkOut: toHM(r?.checkOut),
    checkInOffset: dayOffset(r?.checkIn, date),
    checkOutOffset: dayOffset(r?.checkOut, date),
  };
  return { date, checkIn: orig.checkIn, checkOut: orig.checkOut, orig };
}

/**
 * Only what was touched, for PUT /attendance/:id (the Super Admin part) or
 * POST /attendance/mark: an untouched punch keeps its exact stored instant —
 * re-sending it would cost it its seconds — and on a moved day the server
 * carries it across itself.
 * @param {{date: string, checkIn: string, checkOut: string, orig: object}} form
 * @param {{withDate?: boolean}} [opts] - include a changed date (the edit form)
 * @returns {object} some of { date, checkIn, checkOut }
 */
export function changedPunches(form, { withDate = true } = {}) {
  const { orig } = form;
  if (!orig) return {};
  const out = {};
  if (withDate && form.date !== orig.date) out.date = form.date;
  ['checkIn', 'checkOut'].forEach((k) => {
    if (form[k] !== orig[k]) out[k] = punchAt(form.date, form[k], orig[`${k}Offset`]);
  });
  return out;
}

/** 'YYYY-MM-DD' → 'DD-MM-YYYY', the way the portal prints a day in a message. */
export const dmy = (ymd) => String(ymd || '').split('-').reverse().join('-');
