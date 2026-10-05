import { useEffect, useState } from 'react';
import { toast } from 'react-toastify';
import api from '../api/client';
import PromptDialog from './PromptDialog';
import SearchableSelect from '../components/SearchableSelect';

// Department picker backed by the managed Department list. HR/SuperAdmin can pick
// an existing department or add a new one inline (saved to the list so it's
// available everywhere afterwards). Mirrors DesignationSelect.
// Typing a name that is not in the list offers ＋ Add "<name>" in the search.
// By default that saves it to the managed list at once (as the ＋ Add new
// department… row does). With `createLocally` it is only selected — the caller's
// own save creates it (the Promotions form does, server-side) — and
// `onCreateNew(name)` tells the caller the name is a new one.
export default function DepartmentSelect({
  value = '', onChange, required = false, className, createLocally = false, onCreateNew,
}) {
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
    if (createLocally) { onChange(name); onCreateNew?.(name); return; }
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
      <SearchableSelect
        value={value || ''}
        onChange={handle}
        required={required}
        className={className || 'mt-1 block w-full border rounded-lg px-3 py-2'}
        onCreate={async (name) => {
          if (createLocally) { onChange(name); onCreateNew?.(name); return; }
          try { await addDepartment(name); } catch (err) { toast.error(err.message); }
        }}
        createLabel={(text) => `Add new department “${text}”`}
      >
        <option value="">Select…</option>
        {options.map((d) => <option key={d} value={d}>{d}</option>)}
        {/* Preserve a legacy/free-text value not in the managed list */}
        {value && !options.includes(value) && <option value={value}>{value}</option>}
        <option value="__add__">＋ Add new department…</option>
      </SearchableSelect>
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
