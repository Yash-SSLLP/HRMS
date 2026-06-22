import { useEffect, useState } from 'react';
import api from '../api/client';

// Designation picker backed by the OrgMaster 'Designation' list. HR can pick an
// existing designation or add a new one inline (which is saved to the master so
// it's available everywhere afterwards).
export default function DesignationSelect({ value = '', onChange, required = false, className }) {
  const [options, setOptions] = useState([]);

  const load = async () => {
    try {
      const { data } = await api.get('/org-masters?kind=Designation');
      setOptions((data.masters || []).filter((m) => m.isActive !== false).map((m) => m.name));
    } catch { /* leave empty */ }
  };
  useEffect(() => { load(); }, []);

  const handle = async (e) => {
    const v = e.target.value;
    if (v === '__add__') {
      const name = (window.prompt('New designation name:') || '').trim();
      if (!name) return;
      try {
        await api.post('/org-masters', { kind: 'Designation', name });
        await load();
        onChange(name);
      } catch (err) {
        alert(err.response?.data?.message || 'Could not add designation');
      }
      return;
    }
    onChange(v);
  };

  return (
    <select
      value={value || ''}
      onChange={handle}
      required={required}
      className={className || 'mt-1 block w-full border rounded-lg px-3 py-2'}
    >
      <option value="">— Select —</option>
      {options.map((d) => <option key={d} value={d}>{d}</option>)}
      {/* Preserve a legacy/free-text value not in the managed list */}
      {value && !options.includes(value) && <option value={value}>{value}</option>}
      <option value="__add__">＋ Add new designation…</option>
    </select>
  );
}
