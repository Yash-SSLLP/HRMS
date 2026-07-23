/**
 * ShiftHoursSelect — a dropdown of working-hours / shift presets for the
 * appointment letter, with an "add more" option. Standard shifts are built in;
 * any custom shift an HR adds is remembered in localStorage so it appears in the
 * dropdown next time (per browser). Emits the chosen string via onChange.
 */
import { useEffect, useMemo, useState } from 'react';
import { promptDialog } from './dialogs';

const STANDARD_SHIFTS = [
  '9:30 AM to 6:30 PM, Monday to Saturday',
  '10:00 AM to 7:00 PM, Monday to Saturday',
  '9:00 AM to 6:00 PM, Monday to Friday',
  '9:30 AM to 6:30 PM, Monday to Friday',
];

const LS_KEY = 'hrms.shiftPresets';

const readCustom = () => {
  try {
    const v = JSON.parse(localStorage.getItem(LS_KEY) || '[]');
    return Array.isArray(v) ? v.filter((s) => typeof s === 'string' && s.trim()) : [];
  } catch {
    return [];
  }
};
const writeCustom = (list) => {
  try { localStorage.setItem(LS_KEY, JSON.stringify(list)); } catch { /* ignore quota */ }
};

const ADD_SENTINEL = '__add_shift__';

export default function ShiftHoursSelect({ value, onChange, className = '' }) {
  const [custom, setCustom] = useState(readCustom);

  // Rebuild whenever presets change; include the current value even if it isn't
  // one of the known options (e.g. loaded from an older letter).
  const options = useMemo(() => {
    const set = [];
    const seen = new Set();
    [...STANDARD_SHIFTS, ...custom, ...(value ? [value] : [])].forEach((s) => {
      const key = s.trim();
      if (key && !seen.has(key)) { seen.add(key); set.push(s); }
    });
    return set;
  }, [custom, value]);

  // Default the field to the first standard shift when nothing is chosen yet.
  useEffect(() => {
    if (!value && onChange) onChange(STANDARD_SHIFTS[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const addCustom = async () => {
    const entered = await promptDialog({
      title: 'Add a shift / working hours',
      message: 'Enter the working-hours text exactly as it should read on the letter:',
      placeholder: 'e.g. 8:00 AM to 5:00 PM, Monday to Saturday',
      confirmText: 'Add',
    });
    const v = (entered || '').trim();
    if (!v) return;
    if (!custom.includes(v) && !STANDARD_SHIFTS.includes(v)) {
      const next = [...custom, v];
      setCustom(next);
      writeCustom(next);
    }
    onChange?.(v);
  };

  return (
    <select
      value={value || ''}
      onChange={(e) => (e.target.value === ADD_SENTINEL ? addCustom() : onChange?.(e.target.value))}
      className={className}
    >
      {options.map((opt) => (
        <option key={opt} value={opt}>{opt}</option>
      ))}
      <option value={ADD_SENTINEL}>＋ Add another shift…</option>
    </select>
  );
}
