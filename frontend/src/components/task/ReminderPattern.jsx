/**
 * KEEP REMINDING UNTIL IT IS DONE — in the same shapes as the Repeats builder
 * (2026-09-27). The user, pointing at the recurring form's Repeats section:
 * *"these options should be for sending notifications too"*.
 *
 *   ( on / off )   Hourly · Daily · Weekly · Monthly
 *
 * The switch, then the four shapes in the same four-column control as the
 * Repeats builder above it — five segments did not fit a phone ("Monthly" ran
 * out of its 40px at 375 wide), and a switch says "off" better than a tab does.
 *
 * Hourly goes every N hours ON THE CLOCK inside a window (9 AM – 9 PM unless
 * moved) — 9, 11, 1, 3 …; the others go once on their day, at a time: every day
 * or every N days (alternate days), on the weekdays ticked, or monthly on a
 * date or on "the first Monday". Every shape stops the moment the work is done.
 * The rules live in the server's reminder worker; the words are
 * utils/taskLifecycle's — the same ones the task and the schedule list show.
 *
 * `value` is the one repeating rule (`when: 'EVERY'`), or null for off.
 * `allowOff={false}` drops the switch where removing the rule is somebody
 * else's button (the one-off form's ReminderEditor). Switching it back on
 * restores the shape it had. `hints` seeds a new
 * weekly or monthly rule from the task's own pattern — a Monday-and-Thursday
 * task starts out reminded on Monday and Thursday.
 */
import { useRef } from 'react';
import { FiBell } from 'react-icons/fi';
import Stepper from './Stepper';
import ToggleSwitch from '../ToggleSwitch';
import {
  REMINDER_PATTERNS, DEFAULT_REMIND_AT, DEFAULT_REMIND_WINDOW, MAX_REMIND_EVERY_HOURS,
  WEEKDAYS, WEEKDAY_NAMES, NTH_WEEKS, reminderPattern, reminderWindow, repeatEveryMinutes,
  repeatingReminderText, time12,
} from '../../utils/taskLifecycle';

const ordinal = (n) => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

const chip = (on) => `rounded-lg border px-3 text-xs font-medium transition min-h-[32px] ${
  on ? 'accent-border accent-bg on-accent' : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300'
}`;

const minutesOf = (hhmm) => {
  const [h, m] = String(hhmm).split(':').map((n) => parseInt(n, 10));
  return (h || 0) * 60 + (m || 0);
};
const hhmm = (mins) => `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;

/** A rule of `pattern`, keeping what still makes sense from `prev` (the channel, the time). */
export function repeatingRule(pattern, prev = null, hints = {}) {
  const head = { channel: prev?.channel || 'APP', when: 'EVERY', pattern };
  const at = prev?.at || DEFAULT_REMIND_AT;
  if (pattern === 'DAILY') return { ...head, unit: 'DAYS', amount: 1, at };
  if (pattern === 'WEEKLY') {
    return { ...head, unit: 'DAYS', amount: 1, at, weekdays: hints.weekdays?.length ? [...hints.weekdays] : [1] };
  }
  if (pattern === 'MONTHLY') {
    return {
      ...head,
      unit: 'DAYS',
      amount: 1,
      at,
      monthlyMode: hints.monthlyMode === 'WEEKDAY' ? 'WEEKDAY' : 'DATE',
      monthDay: hints.monthDay || new Date().getDate(),
      nthWeek: hints.nthWeek ?? 1,
      weekday: hints.weekday ?? 1,
    };
  }
  // The window is written into the rule (9 AM – 9 PM, user 2026-09-29), not
  // left to the server's default, so what the form shows is what is saved.
  return { ...head, unit: 'HOURS', amount: 2, from: DEFAULT_REMIND_WINDOW.from, to: DEFAULT_REMIND_WINDOW.to };
}

/**
 * The clock times an hourly rule goes at — "9:00 AM, 11:00 AM … 9:00 PM".
 * `notBefore` ('HH:mm') leaves out what falls before it: a daily task that
 * appears at 9 is not reminded at 9 (the server never sends one within half
 * an hour of a task appearing).
 */
export function hourlyTimes(rule, notBefore = null) {
  const w = reminderWindow(rule);
  const every = repeatEveryMinutes(rule);
  const floor = notBefore ? minutesOf(notBefore) : 0;
  const out = [];
  for (let m = minutesOf(w.from); m <= minutesOf(w.to); m += every) {
    if (m >= floor) out.push(time12(hhmm(m)));
  }
  if (out.length <= 6) return out.join(', ');
  return `${out.slice(0, 3).join(', ')} … ${out[out.length - 1]}`;
}

function TimeBox({ label, value, onChange }) {
  return (
    <label className="text-xs font-medium text-gray-500">
      {label}
      <input
        type="time"
        value={value}
        // A cleared box is not a time — keep the last good one.
        onChange={(e) => { if (e.target.value) onChange(e.target.value); }}
        className="mt-1 block w-full rounded-lg border border-gray-200 px-2 text-sm min-h-[36px]"
      />
    </label>
  );
}

/**
 * `hourlyOnly` (2026-09-29, user: "except Hourly remove other options"): no
 * shape segments — only how often and the From / Until window. Both task forms
 * use it; a rule saved earlier in another shape keeps its own controls until
 * it is taken off, and switching the reminder back on is always hourly.
 */
export default function ReminderPattern({
  value, onChange, allowOff = true, hints = {}, title = 'Keep reminding until it is done', hourlyOnly = false,
}) {
  // The last shape it had, so switching it off and on again does not lose it.
  const last = useRef(value);
  if (value) last.current = value;
  const pattern = value ? reminderPattern(value) : 'OFF';
  const set = (patch) => onChange?.({ ...value, pattern, ...patch });
  const pick = (key) => {
    if (key === pattern) return;
    onChange?.(repeatingRule(key, value, hints));
  };
  const toggle = () => {
    if (value) { onChange?.(null); return; }
    const prev = last.current;
    onChange?.(prev && (!hourlyOnly || reminderPattern(prev) === 'HOURLY') ? prev : repeatingRule('HOURLY', prev, hints));
  };

  // An older "every 90 minutes" rule reads in whole hours here; touching it saves hours.
  const hours = value?.unit === 'MINUTES'
    ? Math.max(1, Math.round((Number(value.amount) || 60) / 60))
    : Math.max(1, Math.min(MAX_REMIND_EVERY_HOURS, Math.round(Number(value?.amount) || 1)));
  const win = value ? { from: value.from || DEFAULT_REMIND_WINDOW.from, to: value.to || DEFAULT_REMIND_WINDOW.to } : DEFAULT_REMIND_WINDOW;
  const badWindow = pattern === 'HOURLY' && !(win.from < win.to);
  const days = value?.weekdays || [];

  return (
    <div className="space-y-3">
      {allowOff && (
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm font-medium text-gray-700">{title}</p>
          <ToggleSwitch
            checked={Boolean(value)}
            onChange={toggle}
            label={value ? 'Stop the repeating reminder' : 'Keep reminding until it is done'}
            size="sm"
          />
        </div>
      )}

      {/* Equal segments, the border on the base — choosing one cannot move the
          others. Four across, like Repeats — two by two below 360px, where the
          modal leaves a four-across row too narrow for "Monthly". */}
      {value && !hourlyOnly && (
        <div className="grid grid-cols-2 gap-1 rounded-xl border border-gray-200 bg-gray-50 p-1 min-[360px]:grid-cols-4" role="tablist" aria-label="How often to remind">
          {REMINDER_PATTERNS.map((s) => {
            const on = pattern === s.key;
            return (
              <button
                key={s.key}
                type="button"
                role="tab"
                aria-selected={on}
                onClick={() => pick(s.key)}
                className={`rounded-lg border text-xs font-semibold transition min-h-[36px] ${
                  on ? 'border-gray-200 bg-white text-gray-900 shadow-sm' : 'border-transparent text-gray-500 hover:text-gray-700'
                }`}
              >
                {s.label}
              </button>
            );
          })}
        </div>
      )}

      {pattern === 'HOURLY' && (
        <>
          {/* No "Every hour / 2 / 3 hours" chips (2026-09-30, user: "remove
              this" — task and recurring); the stepper alone sets the gap. */}
          <div className="flex flex-wrap items-center gap-2">
            <Stepper
              label="Every how many hours"
              value={hours}
              min={1}
              max={MAX_REMIND_EVERY_HOURS}
              onChange={(n) => set({ unit: 'HOURS', amount: n })}
              format={(n) => `every ${n} hour${n === 1 ? '' : 's'}`}
            />
          </div>
          <div className="grid grid-cols-2 gap-3 sm:max-w-sm">
            <TimeBox label="From" value={win.from} onChange={(from) => set({ from, to: win.to })} />
            <TimeBox label="Until" value={win.to} onChange={(to) => set({ from: win.from, to })} />
          </div>
          {badWindow && (
            <p className="text-xs font-medium text-red-600">
              “Until” has to be later than “From” — otherwise it goes between 9:00 AM and 9:00 PM.
            </p>
          )}
        </>
      )}

      {pattern === 'DAILY' && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-gray-500">How often</span>
            {[[1, 'Every day'], [2, 'Alternate days'], [3, 'Every 3 days']].map(([n, label]) => {
              const on = Number(value.amount) === n;
              return (
                <button key={n} type="button" aria-pressed={on} onClick={() => set({ amount: n })} className={chip(on)}>
                  {label}
                </button>
              );
            })}
            <Stepper
              label="Every how many days"
              value={Math.max(1, Math.round(Number(value.amount) || 1))}
              min={1}
              max={31}
              onChange={(n) => set({ amount: n })}
              format={(n) => `every ${n} day${n === 1 ? '' : 's'}`}
            />
          </div>
          <div className="grid grid-cols-2 gap-3 sm:max-w-sm">
            <TimeBox label="At" value={value.at || DEFAULT_REMIND_AT} onChange={(at) => set({ at })} />
          </div>
        </>
      )}

      {pattern === 'WEEKLY' && (
        <>
          <div>
            <p className="mb-1 text-[11px] text-gray-500">On these days</p>
            <div className="grid grid-cols-7 gap-1 sm:flex">
              {WEEKDAYS.map((d, i) => {
                const on = days.includes(i);
                return (
                  <button
                    key={i}
                    type="button"
                    title={WEEKDAY_NAMES[i]}
                    aria-label={WEEKDAY_NAMES[i]}
                    aria-pressed={on}
                    onClick={() => set({ weekdays: on ? days.filter((x) => x !== i) : [...days, i].sort((a, b) => a - b) })}
                    className={`min-h-[32px] min-w-0 sm:min-w-[36px] rounded-lg border text-xs font-medium transition ${
                      on ? 'accent-border accent-bg on-accent' : 'border-gray-200 bg-white text-gray-500'
                    }`}
                  >
                    {d}
                  </button>
                );
              })}
            </div>
            {!days.length && <p className="mt-1 text-xs font-medium text-red-600">Pick at least one day — or turn it off.</p>}
          </div>
          <div className="grid grid-cols-2 gap-3 sm:max-w-sm">
            <TimeBox label="At" value={value.at || DEFAULT_REMIND_AT} onChange={(at) => set({ at })} />
          </div>
        </>
      )}

      {pattern === 'MONTHLY' && (
        <>
          <div className="inline-flex rounded-xl border border-gray-200 bg-gray-50 p-1">
            {[['DATE', 'On a date'], ['WEEKDAY', 'On a weekday']].map(([k, label]) => {
              const on = (value.monthlyMode === 'WEEKDAY' ? 'WEEKDAY' : 'DATE') === k;
              return (
                <button
                  key={k}
                  type="button"
                  aria-pressed={on}
                  onClick={() => set({ monthlyMode: k })}
                  className={`rounded-lg border px-3 text-xs font-semibold transition min-h-[32px] ${
                    on ? 'border-gray-200 bg-white text-gray-900 shadow-sm' : 'border-transparent text-gray-500'
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>
          {value.monthlyMode === 'WEEKDAY' ? (
            <div className="flex flex-wrap items-center gap-2 text-xs text-gray-600">
              The
              <select
                value={value.nthWeek ?? 1}
                onChange={(e) => set({ nthWeek: Number(e.target.value) })}
                className="rounded-lg border border-gray-200 px-2 text-sm min-h-[36px]"
                aria-label="Which one"
              >
                {NTH_WEEKS.map((n) => <option key={n.key} value={n.key}>{n.label.toLowerCase()}</option>)}
              </select>
              <select
                value={value.weekday ?? 1}
                onChange={(e) => set({ weekday: Number(e.target.value) })}
                className="rounded-lg border border-gray-200 px-2 text-sm min-h-[36px]"
                aria-label="Day of the week"
              >
                {[1, 2, 3, 4, 5, 6, 0].map((d) => <option key={d} value={d}>{WEEKDAY_NAMES[d]}</option>)}
              </select>
              of every month
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2 text-xs text-gray-600">
              Day of the month
              <Stepper
                label="Day of the month"
                value={value.monthDay || 1}
                min={1}
                max={31}
                onChange={(n) => set({ monthDay: n })}
                format={ordinal}
              />
              {(value.monthDay || 1) > 28 && <span className="text-gray-400">In a shorter month it goes on the last day.</span>}
            </div>
          )}
          <div className="grid grid-cols-2 gap-3 sm:max-w-sm">
            <TimeBox label="At" value={value.at || DEFAULT_REMIND_AT} onChange={(at) => set({ at })} />
          </div>
        </>
      )}

      {/* The rhythm in words — the words the task itself will show. */}
      {value ? (
        <div className="flex items-start gap-3 rounded-xl px-3 py-2.5" style={{ background: 'color-mix(in srgb, var(--accent) 8%, transparent)' }}>
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg accent-bg on-accent">
            <FiBell size={14} />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-gray-900">{repeatingReminderText(value)}</p>
            <p className="text-xs text-gray-500">
              {pattern === 'HOURLY' && hourlyTimes(value, hints.firstBeatAfter) ? `At ${hourlyTimes(value, hints.firstBeatAfter)}. ` : ''}
              Until it is done — it stops the moment they mark it done.
            </p>
          </div>
        </div>
      ) : (
        <p className="text-xs text-gray-500">No repeating reminder — nobody is chased on a timer.</p>
      )}
    </div>
  );
}
