import { useEffect, useState } from 'react';
import api from '../api/client';
import PromptDialog from './PromptDialog';
import SearchableSelect from './SearchableSelect';

// Which HR consultancy sent a candidate — the Add / Edit Candidate dropdown.
// Lists every consultancy the viewer's company works with (agencies with a
// portal login, whether or not they have sent anybody yet, and names HR has
// recorded before — GET /recruitment/consultancies), "Myself" for a candidate
// found without one (stored as blank), and "＋ Add another consultancy…" for
// an agency not on the list: its name is recorded on the candidate when the
// form saves, and it is on the list from then on.
export default function ConsultancySelect({ value = '', onChange, className, id }) {
  const [options, setOptions] = useState([]);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    let live = true;
    api.get('/recruitment/consultancies')
      .then(({ data }) => { if (live) setOptions(data.consultancies || []); })
      .catch(() => { /* Myself and "Add another" still work */ });
    return () => { live = false; };
  }, []);

  const listed = (name) => options.find((o) => o.toLowerCase() === String(name || '').trim().toLowerCase());

  // "Add another": a name already listed, typed in another case, is picked in
  // its listed spelling rather than starting a second agency; a new one joins
  // the list here and now, so switching away and back does not lose it.
  const addConsultancy = async (typed) => {
    const name = listed(typed) || typed.replace(/\s+/g, ' ').slice(0, 120);
    if (!listed(name)) setOptions((o) => [...o, name].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })));
    onChange(name);
  };

  const handle = (e) => {
    const v = e.target.value;
    if (v === '__add__') { setAdding(true); return; }
    onChange(v);
  };

  return (
    <>
      <SearchableSelect
        id={id}
        value={value || ''}
        onChange={handle}
        className={className || 'block w-full border rounded-lg px-3 py-2'}
      >
        <option value="">Myself</option>
        {options.map((n) => <option key={n} value={n}>{n}</option>)}
        {/* The candidate's own consultancy if the list does not have it (it
            failed to load, or the name is outside what this viewer is shown). */}
        {value && !listed(value) && <option value={value}>{value}</option>}
        <option value="__add__">＋ Add another consultancy…</option>
      </SearchableSelect>
      {adding && (
        <PromptDialog
          title="Add consultancy"
          label="Consultancy name"
          placeholder="e.g. ABC Placements"
          submitLabel="Use"
          onSubmit={addConsultancy}
          onClose={() => setAdding(false)}
        />
      )}
    </>
  );
}
