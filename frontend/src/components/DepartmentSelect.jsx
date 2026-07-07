import { useEffect, useState } from 'react';
import api from '../api/client';
import PromptDialog from './PromptDialog';

// Department picker backed by the managed Department list. HR/SuperAdmin can pick
// an existing department or add a new one inline (saved to the list so it's
// available everywhere afterwards). Mirrors DesignationSelect.
export default function DepartmentSelect({ value = '', onChange, required = false, className }) {
  const [options, setOptions] = useState([]);
  const [adding, setAdding] = useState(false);

  const load = async () => {
    try {
      const { data } = await api.get('/departments');
      setOptions((data.departments || []).filter((d) => d.isActive !== false).map((d) => d.name));
    } catch { /* leave empty */ }
  };
  useEffect(() => { load(); }, []);

  const handle = (e) => {
    const v = e.target.value;
    if (v === '__add__') { setAdding(true); return; }
    onChange(v);
  };

  const addDepartment = async (name) => {
    try {
      await api.post('/departments', { name });
    } catch (err) {
      throw new Error(err.response?.data?.message || 'Could not add department');
    }
    await load();
    onChange(name);
  };

  return (
    <>
      <select
        value={value || ''}
        onChange={handle}
        required={required}
        className={className || 'mt-1 block w-full border rounded-lg px-3 py-2'}
      >
        <option value="">Select…</option>
        {options.map((d) => <option key={d} value={d}>{d}</option>)}
        {/* Preserve a legacy/free-text value not in the managed list */}
        {value && !options.includes(value) && <option value={value}>{value}</option>}
        <option value="__add__">＋ Add new department…</option>
      </select>
      {adding && (
        <PromptDialog
          title="Add department"
          label="New department name"
          placeholder="e.g. Human Resources"
          onSubmit={addDepartment}
          onClose={() => setAdding(false)}
        />
      )}
    </>
  );
}
