/**
 * AttendanceDatePicker — a date field whose calendar colours every day by the
 * state of that day's punches, so an employee raising a regularization can see
 * at a glance which day needs fixing instead of guessing from a bare date box.
 * The web portal's components/AttendanceDatePicker.jsx is the same thing; the
 * rules below are kept deliberately identical so a day never reads green in one
 * app and red in the other.
 *
 *   green  — a clean day: checked in on time and checked out
 *   red    — something to correct: a missing punch, a late check-in, an
 *            absence/half day, or no record at all
 *   violet — never a work day (Sunday, holiday, approved leave), so there is
 *            nothing to regularize and nothing to alarm anyone about
 *
 * Sundays and holidays MUST be recognised from the date itself: the backend
 * never seeds an Attendance row for them (only a punch or an HR entry creates
 * one), so judging them by "has a record" would paint every Sunday red.
 *
 * The month behind the grid comes from GET /attendance/me?year=&month= and the
 * holidays from GET /holidays?year=, both cached for the life of the picker.
 * Picking a day hands the caller the record itself — no second fetch.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';

import api from '../api/client';
import { colors, radius, spacing, font } from '../theme';
import { ModalSheet, Ionicons } from './ui';
import { fmtDate, fmtTime, fmtMinutes, toYMD } from '../utils/format';

const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

// Days that were never expected to carry punches — colouring them red would
// send employees chasing corrections for their own weekly off.
const OFF_STATUSES = ['WeeklyOff', 'Holiday', 'OnLeave'];

const GOOD = colors.chartGood;      // green
const BAD = colors.chartCritical;   // red
const OFF = colors.chart[6];        // violet — the same slot the heatmap gives leave

const pad = (n) => String(n).padStart(2, '0');
const ymdOf = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

// React Native has no color-mix(), so tint and blend by hand.
const rgb = (hex) => {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
/** `hex` at `a` opacity — the cell tint. */
const alpha = (hex, a) => { const [r, g, b] = rgb(hex); return `rgba(${r}, ${g}, ${b}, ${a})`; };
/** `hex` pulled `t` of the way towards the body ink, so it stays legible in both themes. */
const blend = (hex, t) => {
  const [r1, g1, b1] = rgb(hex);
  const [r2, g2, b2] = rgb(colors.text);
  const m = (a, b) => Math.round(a + (b - a) * t);
  return `rgb(${m(r1, r2)}, ${m(g1, g2)}, ${m(b1, b2)})`;
};

/**
 * How a day should read on the calendar.
 * @param {Object|null} record - the Attendance record for that day, if any
 * @param {string} [offReason] - set when the date is a Sunday or a holiday
 * @returns {'good'|'bad'|'off'}
 */
export function dayTone(record, offReason = '') {
  if (record && OFF_STATUSES.includes(record.status)) return 'off';
  // A Sunday or holiday with nothing punched was never a work day. One that was
  // actually worked is judged like any other day — a missed punch-out on a
  // Sunday still needs regularizing.
  if (offReason && !record?.checkIn && !record?.checkOut) return 'off';
  if (!record) return 'bad';
  if (!record.checkIn || !record.checkOut) return 'bad';
  if (record.noPunchOut) return 'bad';
  if (Number(record.lateMinutes) > 0) return 'bad';
  if (record.status === 'Absent' || record.status === 'HalfDay') return 'bad';
  return 'good';
}

/** Plain-language reason, shown under the grid for the highlighted day. */
export function dayNote(record, offReason = '') {
  if (dayTone(record, offReason) === 'off') {
    if (record?.status === 'OnLeave') return 'On leave';
    if (offReason) return offReason;
    return record?.status === 'Holiday' ? 'Holiday' : 'Weekly off';
  }
  if (!record) return 'No attendance recorded';
  const issues = [];
  if (!record.checkIn) issues.push('no check-in');
  if (!record.checkOut) issues.push('no check-out');
  if (record.noPunchOut) issues.push('auto-closed');
  if (Number(record.lateMinutes) > 0) issues.push(`late by ${fmtMinutes(record.lateMinutes)}`);
  if (record.status === 'Absent') issues.push('absent');
  if (record.status === 'HalfDay') issues.push('half day');
  if (issues.length) return issues.join(' · ');
  return `${fmtTime(record.checkIn)} – ${fmtTime(record.checkOut)}`;
}

export default function AttendanceDatePicker({ value, onChange, max = toYMD(new Date()), placeholder = 'Select a date' }) {
  const today = toYMD(new Date());
  const [open, setOpen] = useState(false);
  const [view, setView] = useState(() => {
    const base = value ? new Date(`${value}T00:00:00`) : new Date();
    return { year: base.getFullYear(), month: base.getMonth() + 1 };
  });
  const [month, setMonth] = useState({ state: 'idle', byDate: {} });
  const [holidays, setHolidays] = useState({});
  const cache = useRef({});
  const holidayCache = useRef({});

  // Load the month on screen (once — later visits come from the cache).
  useEffect(() => {
    if (!open) return undefined;
    let alive = true;
    const key = `${view.year}-${view.month}`;
    if (cache.current[key]) { setMonth({ state: 'ready', byDate: cache.current[key] }); return undefined; }
    setMonth({ state: 'loading', byDate: {} });
    api.get(`/attendance/me?year=${view.year}&month=${view.month}`)
      .then(({ data }) => {
        const byDate = {};
        (data.records || []).forEach((r) => { byDate[toYMD(r.date)] = r; });
        cache.current[key] = byDate;
        if (alive) setMonth({ state: 'ready', byDate });
      })
      .catch(() => { if (alive) setMonth({ state: 'error', byDate: {} }); });
    return () => { alive = false; };
  }, [open, view.year, view.month]);

  // Declared holidays for the year on screen. Readable by every employee, so no
  // permission dance; a failure just means holidays fall back to plain days.
  useEffect(() => {
    if (!open) return undefined;
    let alive = true;
    const year = view.year;
    if (holidayCache.current[year]) { setHolidays(holidayCache.current[year]); return undefined; }
    api.get(`/holidays?year=${year}`)
      .then(({ data }) => {
        const map = {};
        (data.holidays || []).forEach((h) => { map[toYMD(h.date)] = h.name; });
        holidayCache.current[year] = map;
        if (alive) setHolidays(map);
      })
      .catch(() => { if (alive) setHolidays({}); });
    return () => { alive = false; };
  }, [open, view.year]);

  // Why this date was never a work day — '' when it is an ordinary one. Sunday
  // is the company's weekly off (the backend hardcodes it the same way).
  const offReason = (ymd) => {
    const name = holidays[ymd];
    if (name) return `Holiday — ${name}`;
    return new Date(`${ymd}T00:00:00`).getDay() === 0 ? 'Weekly off (Sunday)' : '';
  };

  // A Sunday-start month padded with blanks so no week is ragged, chunked into
  // rows of seven for a plain flex layout.
  const weeks = useMemo(() => {
    const { year, month: m } = view;
    const firstWeekday = new Date(year, m - 1, 1).getDay();
    const daysInMonth = new Date(year, m, 0).getDate();
    const flat = [];
    for (let i = 0; i < firstWeekday; i += 1) flat.push(null);
    for (let d = 1; d <= daysInMonth; d += 1) flat.push({ day: d, ymd: ymdOf(year, m, d) });
    while (flat.length % 7 !== 0) flat.push(null);
    const rows = [];
    for (let i = 0; i < flat.length; i += 7) rows.push(flat.slice(i, i + 7));
    return rows;
  }, [view]);

  // How many days of the month on screen are worth a regularization — the
  // headline the employee actually came for.
  const flagged = useMemo(() => {
    if (month.state !== 'ready') return 0;
    return weeks.flat().filter((c) => c && c.ymd <= max
      && dayTone(month.byDate[c.ymd], offReason(c.ymd)) === 'bad').length;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weeks, month, max, holidays]);

  const openPicker = () => {
    const base = value ? new Date(`${value}T00:00:00`) : new Date();
    setView({ year: base.getFullYear(), month: base.getMonth() + 1 });
    setOpen(true);
  };

  const step = (delta) => setView(({ year, month: m }) => {
    const d = new Date(year, m - 1 + delta, 1);
    return { year: d.getFullYear(), month: d.getMonth() + 1 };
  });

  const pick = (ymd) => {
    if (!ymd || ymd > max) return;
    onChange(ymd, {
      state: month.state === 'error' ? 'error' : 'ready',
      record: month.byDate[ymd] || null,
      off: offReason(ymd),
    });
    setOpen(false);
  };

  return (
    <View>
      <TouchableOpacity activeOpacity={0.7} style={styles.picker} onPress={openPicker}>
        <Text style={[styles.pickerText, !value && { color: colors.textFaint }]}>
          {value ? fmtDate(value) : placeholder}
        </Text>
        <Ionicons name="calendar-outline" size={18} color={colors.textMuted} />
      </TouchableOpacity>

      <ModalSheet visible={open} onClose={() => setOpen(false)} title="Pick a date">
        <View style={styles.head}>
          <Text style={font.h3}>{MONTHS[view.month - 1]} {view.year}</Text>
          <View style={{ flexDirection: 'row', gap: spacing(1) }}>
            <TouchableOpacity onPress={() => step(-1)} style={styles.nav} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Ionicons name="chevron-back" size={18} color={colors.textMuted} />
            </TouchableOpacity>
            <TouchableOpacity onPress={() => step(1)} style={styles.nav} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
            </TouchableOpacity>
          </View>
        </View>

        <View style={styles.row}>
          {WEEKDAYS.map((w, i) => <Text key={`${w}${i}`} style={styles.dow}>{w}</Text>)}
        </View>

        {month.state === 'loading' ? (
          <View style={styles.busy}><ActivityIndicator color={colors.primary} /></View>
        ) : (
          weeks.map((week, wi) => (
            <View key={wi} style={styles.row}>
              {week.map((c, ci) => {
                if (!c) return <View key={ci} style={styles.cell} />;
                const future = c.ymd > max;
                const off = offReason(c.ymd);
                const live = month.state === 'ready' && !future;
                const tone = live ? dayTone(month.byDate[c.ymd], off) : '';
                const selected = c.ymd === value;
                const tint = tone === 'good' ? GOOD : tone === 'bad' ? BAD : tone === 'off' ? OFF : null;
                return (
                  <TouchableOpacity
                    key={ci}
                    activeOpacity={0.7}
                    disabled={future}
                    onPress={() => pick(c.ymd)}
                    style={[
                      styles.cell,
                      tint && { backgroundColor: alpha(tint, 0.18) },
                      selected && styles.cellSel,
                    ]}
                  >
                    <Text style={[
                      styles.cellText,
                      tint && { color: blend(tint, 0.28) },
                      future && { color: colors.textFaint },
                      selected && styles.cellTextSel,
                    ]}>
                      {c.day}
                    </Text>
                    {c.ymd === today && <View style={[styles.todayDot, selected && { backgroundColor: '#fff' }]} />}
                  </TouchableOpacity>
                );
              })}
            </View>
          ))
        )}

        <View style={styles.legend}>
          <View style={styles.legendItem}><View style={[styles.key, { backgroundColor: alpha(GOOD, 0.45) }]} /><Text style={font.small}>All good</Text></View>
          <View style={styles.legendItem}><View style={[styles.key, { backgroundColor: alpha(BAD, 0.45) }]} /><Text style={font.small}>Needs fixing</Text></View>
          <View style={styles.legendItem}><View style={[styles.key, { backgroundColor: alpha(OFF, 0.45) }]} /><Text style={font.small}>Off / holiday</Text></View>
          {flagged > 0 && <Text style={[font.small, { marginLeft: 'auto', fontWeight: '700', color: blend(BAD, 0.2) }]}>{flagged} to fix</Text>}
        </View>

        <View style={styles.foot}>
          <TouchableOpacity onPress={() => { onChange('', { state: 'idle', record: null, off: '' }); setOpen(false); }}>
            <Text style={font.small}>Clear</Text>
          </TouchableOpacity>
          {month.state === 'error' && <Text style={font.small}>Attendance unavailable</Text>}
          <TouchableOpacity onPress={() => pick(today)}>
            <Text style={[font.small, { fontWeight: '700', color: colors.primary }]}>Today</Text>
          </TouchableOpacity>
        </View>
      </ModalSheet>
    </View>
  );
}

const styles = StyleSheet.create({
  picker: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.borderStrong,
    borderRadius: radius.md, paddingHorizontal: 14, height: 48,
  },
  pickerText: { fontSize: 15, color: colors.text },

  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing(2) },
  nav: {
    width: 32, height: 32, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.surfaceAlt,
  },
  row: { flexDirection: 'row', gap: 3, marginBottom: 3 },
  dow: { flex: 1, textAlign: 'center', fontSize: 11, fontWeight: '700', color: colors.textMuted, paddingVertical: 4 },
  busy: { paddingVertical: spacing(8), alignItems: 'center' },

  cell: { flex: 1, height: 40, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  cellText: { fontSize: 13, fontWeight: '600', color: colors.text },
  cellSel: { backgroundColor: colors.primary },
  cellTextSel: { color: '#fff' },
  todayDot: { position: 'absolute', bottom: 5, width: 4, height: 4, borderRadius: 2, backgroundColor: colors.primary },

  legend: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: spacing(3), marginTop: spacing(3) },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  key: { width: 10, height: 10, borderRadius: 3 },

  foot: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginTop: spacing(3), paddingTop: spacing(3), borderTopWidth: 1, borderTopColor: colors.border,
  },
});
